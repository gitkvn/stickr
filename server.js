const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const cookie = require('cookie');
const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { PassThrough } = require('stream');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 1024 * 1024 }); // 1MB max message

// ═══════════════════════════════════════════
// R2 OBJECT STORAGE
// ═══════════════════════════════════════════
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'stickr-files';
const ASYNC_FILE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

let s3 = null;
if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('R2 storage configured');
} else {
  console.warn('R2 credentials not configured — async transfers disabled');
}

// ═══════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════
const fs = require('fs');
const DB_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const db = new Database(path.join(DB_DIR, 'stickr.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    picture TEXT,
    username TEXT UNIQUE,
    transfer_balance INTEGER DEFAULT 1073741824,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_transfers (
    file_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_size INTEGER NOT NULL,
    refunded INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS async_files (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT,
    r2_key TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    download_count INTEGER DEFAULT 0,
    batch_token TEXT,
    receive_link_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS batches (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS receive_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    passkey TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pinned_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT,
    r2_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    email TEXT,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrate: add columns if missing
try { db.exec('ALTER TABLE async_files ADD COLUMN batch_token TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE async_files ADD COLUMN receive_link_id TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN username TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN profile_data TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN last_inbox_seen TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN plan TEXT DEFAULT \'free\''); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN plan_expires_at TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN dodo_customer_id TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN dodo_subscription_id TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN transfer_used INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN transfer_used_reset TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE pinned_files ADD COLUMN display_name TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN has_purchased INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)'); } catch (e) { /* already exists */ }

// Checkout sessions tracking (maps Dodo session to user + type)
db.exec(`CREATE TABLE IF NOT EXISTS checkout_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// Contacts — connections between users
db.exec(`CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  access TEXT DEFAULT 'ask',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, contact_id)
)`);

// File requests — incoming transfer requests
db.exec(`CREATE TABLE IF NOT EXISTS file_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  note TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
)`);

// User settings — request preferences
try { db.exec('ALTER TABLE users ADD COLUMN request_pref TEXT DEFAULT \'everyone\''); } catch (e) { /* already exists */ }

// Blocks — permanent block list
db.exec(`CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, blocked_id)
)`);;

// Verify username column exists
const testRow = db.prepare('PRAGMA table_info(users)').all();
const hasUsername = testRow.some(col => col.name === 'username');
if (!hasUsername) {
  console.error('FATAL: username column missing from users table');
  process.exit(1);
}
console.log('DB schema verified: username column exists');

const RESERVED_USERNAMES = new Set(['auth', 'api', 'dl', 'r', 'health', 'privacy', 'admin', 'app', 'login', 'signup', 'settings', 'inbox', 'static', 'public', 'favicon']);

// Prepared statements
const stmts = {
  findUserByGoogleId: db.prepare('SELECT * FROM users WHERE google_id = ?'),
  findUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  createUser: db.prepare('INSERT INTO users (id, google_id, email, name, picture) VALUES (?, ?, ?, ?, ?)'),
  updateUser: db.prepare('UPDATE users SET name = ?, picture = ?, email = ? WHERE google_id = ?'),
  createSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
  findSession: db.prepare(`SELECT s.token as session_token, s.user_id, s.expires_at,
    u.id, u.google_id, u.email, u.name, u.picture, u.username, u.profile_data, u.transfer_balance, u.created_at
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  cleanExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')"),
  updateBalance: db.prepare('UPDATE users SET transfer_balance = ? WHERE id = ?'),
  deductBalance: db.prepare('UPDATE users SET transfer_balance = transfer_balance - ? WHERE id = ? AND transfer_balance >= ?'),
  createPendingTransfer: db.prepare('INSERT INTO pending_transfers (file_id, user_id, file_size) VALUES (?, ?, ?)'),
  findPendingTransfer: db.prepare('SELECT * FROM pending_transfers WHERE file_id = ? AND user_id = ?'),
  markRefunded: db.prepare('UPDATE pending_transfers SET refunded = 1 WHERE file_id = ? AND user_id = ?'),
  cleanOldTransfers: db.prepare("DELETE FROM pending_transfers WHERE created_at < datetime('now', '-1 day')"),
  // Async file queries
  createAsyncFile: db.prepare('INSERT INTO async_files (token, user_id, filename, file_size, mime_type, r2_key, expires_at, batch_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  findAsyncFile: db.prepare('SELECT * FROM async_files WHERE token = ?'),
  incrementDownloadCount: db.prepare('UPDATE async_files SET download_count = download_count + 1 WHERE token = ?'),
  findExpiredFiles: db.prepare("SELECT * FROM async_files WHERE expires_at < datetime('now')"),
  deleteAsyncFile: db.prepare('DELETE FROM async_files WHERE token = ?'),
  // Batch queries
  createBatch: db.prepare('INSERT INTO batches (token, user_id, expires_at) VALUES (?, ?, ?)'),
  findBatch: db.prepare('SELECT * FROM batches WHERE token = ?'),
  findBatchFiles: db.prepare('SELECT * FROM async_files WHERE batch_token = ? ORDER BY created_at ASC'),
  findExpiredBatches: db.prepare("SELECT * FROM batches WHERE expires_at < datetime('now')"),
  deleteBatch: db.prepare('DELETE FROM batches WHERE token = ?'),
  // Username queries
  findUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  setUsername: db.prepare('UPDATE users SET username = ? WHERE id = ?'),
  updateProfileData: db.prepare('UPDATE users SET profile_data = ? WHERE id = ?'),
  updateLastInboxSeen: db.prepare("UPDATE users SET last_inbox_seen = datetime('now') WHERE id = ?"),
  getLastInboxSeen: db.prepare('SELECT last_inbox_seen FROM users WHERE id = ?'),
  // Plan management
  updateUserPlan: db.prepare('UPDATE users SET plan = ?, plan_expires_at = ?, dodo_customer_id = ?, dodo_subscription_id = ? WHERE id = ?'),
  markPurchased: db.prepare('UPDATE users SET has_purchased = 1 WHERE id = ?'),
  updateUserPlanByDodoCustomer: db.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE dodo_customer_id = ?'),
  findUserByDodoCustomer: db.prepare('SELECT * FROM users WHERE dodo_customer_id = ?'),
  findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserPlan: db.prepare('SELECT plan, plan_expires_at, transfer_used, transfer_used_reset, has_purchased FROM users WHERE id = ?'),
  addTransferUsed: db.prepare('UPDATE users SET transfer_used = transfer_used + ? WHERE id = ?'),
  resetTransferUsed: db.prepare("UPDATE users SET transfer_used = 0, transfer_used_reset = datetime('now') WHERE id = ?"),
  // Receive link queries
  createReceiveLink: db.prepare('INSERT INTO receive_links (id, user_id, passkey, expires_at) VALUES (?, ?, ?, ?)'),
  deactivateUserReceiveLinks: db.prepare('UPDATE receive_links SET active = 0 WHERE user_id = ?'),
  findActiveReceiveLink: db.prepare('SELECT * FROM receive_links WHERE user_id = ? AND active = 1'),
  findReceiveLinkById: db.prepare('SELECT * FROM receive_links WHERE id = ?'),
  findReceiveLinkByUserAndPasskey: db.prepare('SELECT rl.* FROM receive_links rl JOIN users u ON rl.user_id = u.id WHERE u.username = ? AND rl.passkey = ? AND rl.active = 1'),
  // Inbox queries
  findReceivedFiles: db.prepare("SELECT * FROM async_files WHERE receive_link_id IS NOT NULL AND user_id = ? ORDER BY created_at DESC"),
  createReceivedFile: db.prepare('INSERT INTO async_files (token, user_id, filename, file_size, mime_type, r2_key, expires_at, receive_link_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  // Pinned files queries
  findPinnedFiles: db.prepare('SELECT * FROM pinned_files WHERE user_id = ? ORDER BY created_at ASC'),
  findPinnedFilesByUsername: db.prepare('SELECT pf.* FROM pinned_files pf JOIN users u ON pf.user_id = u.id WHERE u.username = ?'),
  countPinnedFiles: db.prepare('SELECT COUNT(*) as count FROM pinned_files WHERE user_id = ?'),
  createPinnedFile: db.prepare('INSERT INTO pinned_files (id, user_id, filename, file_size, mime_type, r2_key, display_name) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  deletePinnedFile: db.prepare('DELETE FROM pinned_files WHERE id = ? AND user_id = ?'),
  findPinnedFileById: db.prepare('SELECT * FROM pinned_files WHERE id = ?'),
  // Stats queries
  totalUsers: db.prepare('SELECT COUNT(*) as count FROM users'),
  totalTransfers: db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as total_bytes FROM pending_transfers'),
  recentTransfers: db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as total_bytes FROM pending_transfers WHERE created_at > datetime('now', '-24 hours')"),
  topUsers: db.prepare(`SELECT u.email, u.name, u.transfer_balance, 
    COUNT(pt.file_id) as transfers, COALESCE(SUM(pt.file_size), 0) as bytes_sent 
    FROM users u LEFT JOIN pending_transfers pt ON u.id = pt.user_id 
    GROUP BY u.id ORDER BY bytes_sent DESC LIMIT 10`),
  usersNearLimit: db.prepare('SELECT email, name, transfer_balance FROM users WHERE transfer_balance < 52428800 ORDER BY transfer_balance ASC LIMIT 10'),
  // Contacts queries
  addContact: db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)'),
  getContacts: db.prepare(`SELECT c.*, u.name, u.username, u.picture FROM contacts c JOIN users u ON c.contact_id = u.id WHERE c.user_id = ? ORDER BY c.created_at DESC`),
  getContact: db.prepare('SELECT * FROM contacts WHERE user_id = ? AND contact_id = ?'),
  updateContactAccess: db.prepare('UPDATE contacts SET access = ? WHERE user_id = ? AND contact_id = ?'),
  deleteContact: db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?'),
  // File request queries
  createFileRequest: db.prepare('INSERT INTO file_requests (from_user_id, to_user_id, note) VALUES (?, ?, ?)'),
  getPendingRequests: db.prepare(`SELECT fr.*, u.name as from_name, u.username as from_username, u.picture as from_picture FROM file_requests fr JOIN users u ON fr.from_user_id = u.id WHERE fr.to_user_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`),
  getRequestById: db.prepare('SELECT * FROM file_requests WHERE id = ?'),
  updateRequestStatus: db.prepare('UPDATE contacts SET access = ? WHERE user_id = ? AND contact_id = ?'),
  setRequestStatus: db.prepare('UPDATE file_requests SET status = ? WHERE id = ?'),
  // User request preference
  getRequestPref: db.prepare('SELECT request_pref FROM users WHERE id = ?'),
  setRequestPref: db.prepare('UPDATE users SET request_pref = ? WHERE id = ?'),
};

// Generate username from email (must be after stmts)
function generateUsername(email) {
  let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!base || base.length < 2) base = 'user';
  if (RESERVED_USERNAMES.has(base)) base = base + '1';
  let username = base;
  let attempt = 0;
  while (stmts.findUserByUsername.get(username)) {
    attempt++;
    username = base + attempt;
  }
  return username;
}

// Assign usernames to existing users who don't have one
{
  const usersWithoutUsername = db.prepare('SELECT id, email FROM users WHERE username IS NULL').all();
  for (const u of usersWithoutUsername) {
    const username = generateUsername(u.email);
    stmts.setUsername.run(username, u.id);
    console.log(`Assigned username @${username} to ${u.email}`);
  }
}

// Clean expired sessions every hour
setInterval(async () => {
  stmts.cleanExpiredSessions.run();
  stmts.cleanOldTransfers.run();
  // Clean expired async files from R2
  if (s3) {
    const expired = stmts.findExpiredFiles.all();
    for (const file of expired) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: file.r2_key }));
      } catch (err) {
        console.warn('Failed to delete R2 object:', file.r2_key, err.message);
      }
      stmts.deleteAsyncFile.run(file.token);
    }
    if (expired.length > 0) console.log(`Cleaned ${expired.length} expired async files`);
    // Clean expired batches
    const expiredBatches = stmts.findExpiredBatches.all();
    for (const batch of expiredBatches) {
      stmts.deleteBatch.run(batch.token);
    }
  }
}, 60 * 60 * 1000);

// ═══════════════════════════════════════════
// AUTH HELPERS
// ═══════════════════════════════════════════
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_COOKIE = 'stickr_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function setSessionCookie(res, token) {
  res.append('Set-Cookie', cookie.serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE / 1000,
  }));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', cookie.serialize(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  }));
}

function getUserFromCookie(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = stmts.findSession.get(token);
  if (!row) return null;
  return {
    id: row.user_id,
    google_id: row.google_id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    username: row.username,
    profile_data: row.profile_data ? JSON.parse(row.profile_data) : null,
    transfer_balance: row.transfer_balance,
    created_at: row.created_at,
  };
}

// ═══════════════════════════════════════════
// GOOGLE OAUTH ROUTES
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════
const rateLimitBuckets = {};
function rateLimit(name, maxRequests, windowMs) {
  if (!rateLimitBuckets[name]) rateLimitBuckets[name] = new Map();
  const bucket = rateLimitBuckets[name];
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    let entry = bucket.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      bucket.set(ip, entry);
    }
    entry.count++;
    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const name in rateLimitBuckets) {
    for (const [ip, entry] of rateLimitBuckets[name]) {
      if (now > entry.resetAt) rateLimitBuckets[name].delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Dodo webhook handler — MUST be before express.json() to receive raw body
app.post('/api/webhook/dodo', express.raw({ type: 'application/json' }), (req, res) => {
  if (!DODO_WEBHOOK_SECRET) {
    console.warn('Dodo webhook received but no secret configured');
    return res.status(200).send('OK');
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

  // Verify webhook signature (Dodo uses standard webhook signature scheme)
  const webhookId = req.headers['webhook-id'];
  const webhookTimestamp = req.headers['webhook-timestamp'];
  const webhookSignature = req.headers['webhook-signature'];

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    console.warn('Dodo webhook missing headers');
    return res.status(400).send('Missing webhook headers');
  }

  // Replay protection: reject timestamps older than 5 minutes
  const ts = parseInt(webhookTimestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    console.warn('Dodo webhook timestamp too old or invalid');
    return res.status(400).send('Invalid timestamp');
  }

  // HMAC-SHA256 signature verification
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody.toString()}`;
  const secretBytes = Buffer.from(DODO_WEBHOOK_SECRET.startsWith('whsec_') ? DODO_WEBHOOK_SECRET.slice(6) : DODO_WEBHOOK_SECRET, 'base64');
  const expectedSig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  // Dodo sends multiple signatures separated by space, each prefixed with "v1,"
  const signatures = webhookSignature.split(' ').map(s => s.replace('v1,', ''));
  const valid = signatures.some(sig => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'base64'), Buffer.from(expectedSig, 'base64'));
    } catch { return false; }
  });

  if (!valid) {
    console.warn('Dodo webhook signature verification failed');
    return res.status(401).send('Invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  console.log('Dodo webhook verified:', payload.type, JSON.stringify(payload).slice(0, 500));

  const eventType = payload.type || payload.event_type;

  switch (eventType) {
    case 'subscription.active':
    case 'subscription.renewed': {
      const sub = payload.data || payload;
      const customerId = sub.customer_id || (sub.customer && sub.customer.customer_id);
      const subscriptionId = sub.subscription_id || sub.id;
      const userId = sub.metadata && sub.metadata.user_id;

      if (userId) {
        const expiresAt = sub.current_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        stmts.updateUserPlan.run('pro', expiresAt, customerId || null, subscriptionId || null, userId);
        stmts.markPurchased.run(userId);
        console.log(`Pro activated for user ${userId}`);
      } else if (customerId) {
        const user = stmts.findUserByDodoCustomer.get(customerId);
        if (user) {
          const expiresAt = sub.current_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          stmts.updateUserPlan.run('pro', expiresAt, customerId, subscriptionId || null, user.id);
          stmts.markPurchased.run(user.id);
          console.log(`Pro activated for user ${user.id} via customer ${customerId}`);
        }
      }
      break;
    }

    case 'subscription.cancelled':
    case 'subscription.expired':
    case 'subscription.failed': {
      const sub = payload.data || payload;
      const customerId = sub.customer_id || (sub.customer && sub.customer.customer_id);
      const userId = sub.metadata && sub.metadata.user_id;

      if (userId) {
        stmts.updateUserPlan.run('free', null, null, null, userId);
        console.log(`Pro deactivated for user ${userId}`);
      } else if (customerId) {
        stmts.updateUserPlanByDodoCustomer.run('free', null, customerId);
        console.log(`Pro deactivated for customer ${customerId}`);
      }
      break;
    }

    case 'payment.succeeded':
    case 'payment.completed': {
      const payment = payload.data || payload;
      const checkoutSessionId = payment.checkout_session_id || null;
      const productId = payment.product_id || (payment.product_cart && payment.product_cart[0] && payment.product_cart[0].product_id) || null;

      // Try to find user from checkout session tracking
      let userId = payment.metadata && payment.metadata.user_id;
      let paymentType = payment.metadata && payment.metadata.type;

      if (checkoutSessionId) {
        const session = db.prepare('SELECT user_id, type FROM checkout_sessions WHERE session_id = ?').get(checkoutSessionId);
        if (session) {
          userId = session.user_id;
          paymentType = session.type;
          // Clean up used session
          db.prepare('DELETE FROM checkout_sessions WHERE session_id = ?').run(checkoutSessionId);
          console.log('Matched checkout session:', checkoutSessionId, '→ user:', userId, 'type:', paymentType);
        }
      }

      console.log('Payment webhook detail — userId:', userId, 'type:', paymentType, 'productId:', productId, 'sessionId:', checkoutSessionId);

      if (!userId) {
        console.log('Payment webhook: no user_id found, skipping');
        break;
      }

      if (paymentType === 'topup') {
        const topupBytes = 10 * 1024 * 1024 * 1024; // 10GB
        db.prepare('UPDATE users SET transfer_balance = transfer_balance + ?, has_purchased = 1 WHERE id = ?').run(topupBytes, userId);
        console.log(`Top-up: added 10GB to user ${userId}`);
      } else if (paymentType === 'pro') {
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const customerId = payment.customer_id || (payment.customer && payment.customer.customer_id) || null;
        stmts.updateUserPlan.run('pro', expiresAt, customerId, null, userId);
        stmts.markPurchased.run(userId);
        console.log(`Pro activated for user ${userId} via payment.succeeded`);
      } else {
        console.log('Payment webhook: unknown type, logging only');
      }
      break;
    }

    default:
      console.log('Dodo webhook unhandled event:', eventType);
  }

  res.status(200).send('OK');
});

app.use(express.json());

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).send('Google OAuth not configured');
  }
  const redirectUri = `${getBaseUrl(req)}/auth/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  // Store state in cookie for verification on callback
  res.append('Set-Cookie', cookie.serialize('oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes
  }));
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state: state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/callback', rateLimit('auth', 10, 60 * 1000), async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  // Verify OAuth state to prevent CSRF
  const cookies = cookie.parse(req.headers.cookie || '');
  const storedState = cookies.oauth_state;
  if (!state || !storedState || state !== storedState) {
    return res.redirect('/?error=invalid_state');
  }
  // Clear the state cookie
  res.append('Set-Cookie', cookie.serialize('oauth_state', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  }));

  try {
    const redirectUri = `${getBaseUrl(req)}/auth/callback`;

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const tokenData = await tokenRes.json();

    // Get user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) throw new Error('Failed to fetch user info');
    const profile = await userRes.json();

    // Find or create user
    let user = stmts.findUserByGoogleId.get(profile.id);
    if (user) {
      stmts.updateUser.run(profile.name, profile.picture, profile.email, profile.id);
      user = stmts.findUserByGoogleId.get(profile.id);
      // Assign username if missing (existing users)
      if (!user.username) {
        const username = generateUsername(profile.email);
        stmts.setUsername.run(username, user.id);
        user = stmts.findUserById.get(user.id);
      }
    } else {
      const userId = uuidv4();
      stmts.createUser.run(userId, profile.id, profile.email, profile.name, profile.picture || null);
      user = stmts.findUserById.get(userId);
      // Assign username for new user
      const username = generateUsername(profile.email);
      stmts.setUsername.run(username, user.id);
      user = stmts.findUserById.get(userId);
    }

    // Create session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
    stmts.createSession.run(sessionToken, user.id, expiresAt);

    setSessionCookie(res, sessionToken);
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/me', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    picture: user.picture,
    username: user.username,
    profile_data: user.profile_data,
    plan: isProUser(user.id) ? 'pro' : 'free',
    transferBalance: user.transfer_balance,
    transferUsed: (() => {
      const row = stmts.getUserPlan.get(user.id);
      if (isProUser(user.id)) {
        if (row && row.transfer_used_reset) {
          const resetDate = new Date(row.transfer_used_reset);
          if (new Date() - resetDate > 30 * 24 * 60 * 60 * 1000) {
            stmts.resetTransferUsed.run(user.id);
            return 0;
          }
          return row.transfer_used || 0;
        } else if (row) {
          stmts.resetTransferUsed.run(user.id);
          return 0;
        }
      }
      return row ? (row.transfer_used || 0) : 0;
    })(),
    planLimits: getUserPlanLimits(user.id),
    receiveLink: (() => {
      const rl = stmts.findActiveReceiveLink.get(user.id);
      if (!rl) return null;
      if (new Date(rl.expires_at) < new Date()) return null;
      return { id: rl.id, expiresAt: rl.expires_at };
    })(),
  });
});

app.get('/auth/logout', (req, res) => {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  if (token) stmts.deleteSession.run(token);
  clearSessionCookie(res);
  res.redirect('/');
});

// ═══════════════════════════════════════════
// STATIC FILES
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// ASYNC FILE TRANSFER (R2)
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// PAYMENTS (Dodo)
// ═══════════════════════════════════════════
const DODO_API_KEY = process.env.DODO_API_KEY || '';
const DODO_WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET || '';
const DODO_TOPUP_PRODUCT_ID = process.env.DODO_TOPUP_PRODUCT_ID || '';
const DODO_PRO_PRODUCT_ID = process.env.DODO_PRO_PRODUCT_ID || '';
const DODO_ENV = process.env.DODO_ENV || 'test_mode';
const DODO_API_BASE = DODO_ENV === 'live_mode' ? 'https://api.dodopayments.com' : 'https://test.dodopayments.com';

// Create checkout session for Pro subscription
app.post('/api/checkout/pro', async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  if (isProUser(user.id)) {
    return res.status(400).json({ error: 'Already on Pro' });
  }

  if (!DODO_API_KEY || !DODO_PRO_PRODUCT_ID) {
    return res.status(503).json({ error: 'Payments not configured yet' });
  }

  try {
    const baseUrl = getBaseUrl(req);
    const response = await fetch(`${DODO_API_BASE}/checkouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DODO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_cart: [
          { product_id: DODO_PRO_PRODUCT_ID, quantity: 1 },
        ],
        customer: {
          email: user.email,
          name: user.name || user.username,
        },
        return_url: `${baseUrl}/?upgrade=success`,
        metadata: {
          user_id: String(user.id),
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Dodo checkout error:', data);
      return res.status(500).json({ error: 'Failed to create checkout' });
    }

    // Store Dodo customer ID if provided
    if (data.customer_id) {
      stmts.updateUserPlan.run(user.plan || 'free', null, data.customer_id, null, user.id);
    }

    // Track checkout session for webhook matching
    if (data.session_id) {
      db.prepare('INSERT OR REPLACE INTO checkout_sessions (session_id, user_id, type) VALUES (?, ?, ?)').run(data.session_id, user.id, 'pro');
      console.log('Stored checkout session:', data.session_id, 'type: pro, user:', user.id);
    }

    res.json({ url: data.checkout_url });
  } catch (err) {
    console.error('Dodo checkout error:', err);
    res.status(500).json({ error: 'Payment service unavailable' });
  }
});

// Create checkout session for 10 GB top-up (one-time payment)
app.post('/api/checkout/topup', async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  if (!DODO_API_KEY || !DODO_TOPUP_PRODUCT_ID) {
    return res.status(503).json({ error: 'Payments not configured yet' });
  }

  try {
    const baseUrl = getBaseUrl(req);
    const response = await fetch(`${DODO_API_BASE}/checkouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DODO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_cart: [
          { product_id: DODO_TOPUP_PRODUCT_ID, quantity: 1 },
        ],
        customer: {
          email: user.email,
          name: user.name || user.username,
        },
        return_url: `${baseUrl}/?topup=success`,
        metadata: {
          user_id: String(user.id),
          type: 'topup',
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Dodo topup checkout error:', data);
      return res.status(500).json({ error: 'Failed to create checkout' });
    }

    // Track checkout session for webhook matching
    if (data.session_id) {
      db.prepare('INSERT OR REPLACE INTO checkout_sessions (session_id, user_id, type) VALUES (?, ?, ?)').run(data.session_id, user.id, 'topup');
      console.log('Stored checkout session:', data.session_id, 'type: topup, user:', user.id);
    }

    res.json({ url: data.checkout_url });
  } catch (err) {
    console.error('Dodo topup checkout error:', err);
    res.status(500).json({ error: 'Payment service unavailable' });
  }
});

// Get current plan status
app.get('/api/plan', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const plan = getUserPlanLimits(user.id);
  const pro = isProUser(user.id);
  const row = stmts.getUserPlan.get(user.id);

  res.json({
    plan: pro ? 'pro' : 'free',
    limits: plan,
    transferUsed: row ? row.transfer_used : 0,
    expiresAt: pro && row ? row.plan_expires_at : null,
  });
});

// ═══════════════════════════════════════════
// RECEIVE LINKS + INBOX
// ═══════════════════════════════════════════

// Generate a new upload link
app.post('/api/receive-link/create', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (!user.username) return res.status(400).json({ error: 'No username set' });

  // Only paid users (top-up or pro) can create receive links
  const limits = getUserPlanLimits(user.id);
  if (!limits.canReceiveLink) return res.status(403).json({ error: 'Upgrade to unlock receive links' });

  stmts.deactivateUserReceiveLinks.run(user.id);

  const id = crypto.randomBytes(12).toString('hex'); // 24-char token
  const passkey = id; // The key IS the link token
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

  stmts.createReceiveLink.run(id, user.id, passkey, expiresAt);

  const host = req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const url = `${protocol}://${host}/${user.username}?key=${id}`;

  res.json({ url, expiresAt });
});

// Validate an upload key
app.post('/api/receive-link/validate', (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const link = stmts.findReceiveLinkById.get(key);
  if (!link || !link.active) return res.status(403).json({ error: 'Invalid or expired link' });
  if (new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired' });

  res.json({ valid: true, linkId: link.id });
});

// Create a batch for receive link uploads (no auth needed, just valid link)
app.post('/api/receive/batch', rateLimit('receive-batch', 20, 60 * 1000), (req, res) => {
  const linkId = req.headers['x-receive-link-id'];
  if (!linkId) return res.status(400).json({ error: 'Missing link ID' });

  const link = stmts.findReceiveLinkById.get(linkId);
  if (!link || !link.active) return res.status(403).json({ error: 'Invalid receive link' });
  if (new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired' });

  const token = crypto.randomBytes(16).toString('hex');
  const recipientLimits = getUserPlanLimits(link.user_id);
  const expiresAt = new Date(Date.now() + recipientLimits.linkExpiry).toISOString();
  stmts.createBatch.run(token, link.user_id, expiresAt);

  res.json({ token });
});

// Upload to someone's profile (passcode verified, no auth needed for sender)
app.post('/api/receive/upload', rateLimit('receive-upload', 10, 60 * 1000), async (req, res) => {
  if (!s3) return res.status(503).json({ error: 'Storage not available' });

  const linkId = req.headers['x-receive-link-id'];
  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  const mimeType = req.headers['x-mime-type'] || 'application/octet-stream';
  const declaredSize = parseInt(req.headers['content-length'], 10);
  const batchToken = req.headers['x-batch-token'] || null;

  if (!linkId || !filename) return res.status(400).json({ error: 'Missing link ID or filename' });

  const link = stmts.findReceiveLinkById.get(linkId);
  if (!link || !link.active) return res.status(403).json({ error: 'Invalid receive link' });
  if (new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired' });

  // Use the recipient's plan limits for max file size
  const recipientLimits = getUserPlanLimits(link.user_id);
  const recvMaxSize = recipientLimits.maxFileSize;
  if (declaredSize > recvMaxSize) {
    return res.status(413).json({ error: 'file_too_large', maxSize: recvMaxSize });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const r2Key = `received/${link.user_id}/${token}/${sanitizeFilename(filename)}`;
  const expiresAt = new Date(Date.now() + recipientLimits.linkExpiry).toISOString();

  let bytesReceived = 0;
  const passthrough = new PassThrough();

  req.on('data', (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived > recvMaxSize) {
      passthrough.destroy(new Error('File too large'));
      req.destroy();
      return;
    }
    passthrough.write(chunk);
  });
  req.on('end', () => passthrough.end());
  req.on('error', (err) => passthrough.destroy(err));

  try {
    const upload = new Upload({
      client: s3,
      params: { Bucket: R2_BUCKET_NAME, Key: r2Key, Body: passthrough, ContentType: mimeType },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
    });

    const recvTimeoutMs = Math.max(5 * 60 * 1000, Math.ceil(declaredSize / (1024 * 1024)) * 1000 + 5 * 60 * 1000);
    const uploadTimeout = setTimeout(() => { upload.abort(); passthrough.destroy(new Error("Upload timeout")); req.destroy(); }, recvTimeoutMs);

    await upload.done();
    clearTimeout(uploadTimeout);

    stmts.createReceivedFile.run(token, link.user_id, filename, bytesReceived, mimeType, r2Key, expiresAt, link.id);
    // Tag with batch if provided AND batch belongs to this recipient
    if (batchToken) {
      const batch = stmts.findBatch.get(batchToken);
      if (batch && batch.user_id === link.user_id) {
        try { db.prepare('UPDATE async_files SET batch_token = ? WHERE token = ?').run(batchToken, token); } catch(e) {}
      }
    }

    // Push inbox notification via WebSocket
    notifyInbox(link.user_id);

    // Deduct from recipient — check if Pro quota covers it or needs topup overflow
    const recvQuota = checkTransferQuota(link.user_id, bytesReceived);
    stmts.addTransferUsed.run(bytesReceived, link.user_id);
    if (recvQuota.source !== 'pro') {
      stmts.deductBalance.run(bytesReceived, link.user_id, bytesReceived);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Receive upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Inbox — list received files (grouped by batch)
app.get('/api/inbox', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const files = stmts.findReceivedFiles.all(user.id);
  const active = files.filter(f => new Date(f.expires_at) > new Date());

  // Group batched files, keep singles as-is
  const seen = new Set();
  const result = [];
  for (const f of active) {
    if (f.batch_token && !seen.has(f.batch_token)) {
      seen.add(f.batch_token);
      const batchFiles = active.filter(bf => bf.batch_token === f.batch_token);
      const totalSize = batchFiles.reduce((s, bf) => s + bf.file_size, 0);
      result.push({
        token: f.batch_token,
        is_batch: true,
        file_count: batchFiles.length,
        filename: batchFiles.length + ' files',
        file_size: totalSize,
        mime_type: null,
        created_at: f.created_at,
        expires_at: f.expires_at,
        batch_url: '/dl/b/' + f.batch_token,
      });
    } else if (f.batch_token && seen.has(f.batch_token)) {
      // skip — already grouped
    } else {
      result.push(f);
    }
  }
  res.json(result);
});

// Mark inbox as seen
app.post('/api/inbox/seen', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  stmts.updateLastInboxSeen.run(user.id);
  res.json({ ok: true });
});

// Get unseen inbox count
app.get('/api/inbox/unseen', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const lastSeen = stmts.getLastInboxSeen.get(user.id);
  const lastSeenTime = lastSeen && lastSeen.last_inbox_seen ? lastSeen.last_inbox_seen : '1970-01-01';
  const files = stmts.findReceivedFiles.all(user.id);
  const count = files.filter(f => new Date(f.expires_at) > new Date() && f.created_at > lastSeenTime).length;
  res.json({ count });
});

// Delete from inbox
app.delete('/api/inbox/:token', async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const file = stmts.findAsyncFile.get(req.params.token);
  if (!file || file.user_id !== user.id) return res.status(404).json({ error: 'File not found' });

  if (s3) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: file.r2_key })); } catch {}
  }
  stmts.deleteAsyncFile.run(req.params.token);
  res.json({ success: true });
});

// Delete all files in a batch from inbox
app.delete('/api/inbox/batch/:batchToken', async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const files = stmts.findBatchFiles.all(req.params.batchToken);
  const userFiles = files.filter(f => f.user_id === user.id);
  if (userFiles.length === 0) return res.status(404).json({ error: 'Batch not found' });

  for (const file of userFiles) {
    if (s3) {
      try { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: file.r2_key })); } catch {}
    }
    stmts.deleteAsyncFile.run(file.token);
  }
  stmts.deleteBatch.run(req.params.batchToken);
  res.json({ success: true, deleted: userFiles.length });
});

// ═══════════════════════════════════════════
// PINNED FILES
// ═══════════════════════════════════════════

app.get('/api/pins', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(stmts.findPinnedFiles.all(user.id));
});

app.post('/api/pin', rateLimit('pin', 10, 60 * 1000), async (req, res) => {
  if (!s3) return res.status(503).json({ error: 'Storage not available' });

  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const pinLimits = getUserPlanLimits(user.id);
  const count = stmts.countPinnedFiles.get(user.id);
  if (count.count >= pinLimits.maxPins) return res.status(400).json({ error: `Maximum ${pinLimits.maxPins} pinned files` });

  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  const displayName = decodeURIComponent(req.headers['x-display-name'] || '') || filename;
  const mimeType = req.headers['x-mime-type'] || 'application/octet-stream';
  const declaredSize = parseInt(req.headers['content-length'], 10);

  if (!filename) return res.status(400).json({ error: 'Missing filename' });

  const maxPinSize = pinLimits.maxPinSize;
  if (declaredSize > maxPinSize) {
    return res.status(413).json({ error: `Pinned files must be under ${Math.round(maxPinSize / 1048576)} MB` });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const r2Key = `pinned/${user.id}/${id}/${sanitizeFilename(filename)}`;

  let bytesReceived = 0;
  const passthrough = new PassThrough();

  req.on('data', (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived > maxPinSize) {
      passthrough.destroy(new Error('File too large'));
      req.destroy();
      return;
    }
    passthrough.write(chunk);
  });
  req.on('end', () => passthrough.end());
  req.on('error', (err) => passthrough.destroy(err));

  try {
    const upload = new Upload({
      client: s3,
      params: { Bucket: R2_BUCKET_NAME, Key: r2Key, Body: passthrough, ContentType: mimeType },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
    });

    const pinTimeout = setTimeout(() => { upload.abort(); passthrough.destroy(new Error('Upload timeout')); req.destroy(); }, 5 * 60 * 1000);
    await upload.done();
    clearTimeout(pinTimeout);

    stmts.createPinnedFile.run(id, user.id, filename, bytesReceived, mimeType, r2Key, displayName);
    res.json({ id, filename, display_name: displayName, file_size: bytesReceived });
  } catch (err) {
    console.error('Pin upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.delete('/api/pin/:id', async (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const pin = stmts.findPinnedFileById.get(req.params.id);
  if (!pin || pin.user_id !== user.id) return res.status(404).json({ error: 'Not found' });

  if (s3) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: pin.r2_key })); } catch {}
  }
  stmts.deletePinnedFile.run(req.params.id, user.id);
  res.json({ success: true });
});

// Update profile (bio + social links)
app.post('/api/profile', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { bio, links, card } = req.body;
  const profileData = {
    bio: typeof bio === 'string' ? bio.slice(0, 160) : '',
    links: Array.isArray(links) ? links.slice(0, 3).map(l => ({
      url: typeof l.url === 'string' ? l.url.slice(0, 500) : '',
    })).filter(l => l.url && (l.url.startsWith('https://') || l.url.startsWith('http://'))) : [],
  };

  if (card && typeof card === 'object') {
    profileData.card = {
      name: typeof card.name === 'string' ? card.name.slice(0, 100) : '',
      phone: typeof card.phone === 'string' ? card.phone.slice(0, 30) : '',
      email: typeof card.email === 'string' ? card.email.slice(0, 100) : '',
      company: typeof card.company === 'string' ? card.company.slice(0, 100) : '',
      title: typeof card.title === 'string' ? card.title.slice(0, 100) : '',
      website: typeof card.website === 'string' ? card.website.slice(0, 200) : '',
    };
  }

  stmts.updateProfileData.run(JSON.stringify(profileData), user.id);
  res.json(profileData);
});

// Update username
app.post('/api/username', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { username } = req.body;
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username is required' });
  }

  const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (clean.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (clean.length > 20) return res.status(400).json({ error: 'Username must be 20 characters or less' });
  if (RESERVED_USERNAMES.has(clean)) return res.status(400).json({ error: 'This username is reserved' });
  if (clean === user.username) return res.json({ username: clean });

  const existing = stmts.findUserByUsername.get(clean);
  if (existing) return res.status(409).json({ error: 'Username is already taken' });

  stmts.setUsername.run(clean, user.id);
  res.json({ username: clean });
});

// Check username availability
app.get('/api/username/check', (req, res) => {
  const name = (req.query.u || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (name.length < 3) return res.json({ available: false, reason: 'Too short' });
  if (name.length > 20) return res.json({ available: false, reason: 'Too long' });
  if (RESERVED_USERNAMES.has(name)) return res.json({ available: false, reason: 'Reserved' });
  const existing = stmts.findUserByUsername.get(name);
  if (existing) return res.json({ available: false, reason: 'Taken' });
  return res.json({ available: true });
});

// Search users by partial username (min 3 chars, max 5 results)
app.get('/api/users/search', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const q = (req.query.q || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (q.length < 3) return res.json([]);
  const results = db.prepare(
    `SELECT id, name, username, picture FROM users WHERE username LIKE ? AND id != ? LIMIT 5`
  ).all(q + '%', user.id);
  // Mark which are contacts
  const contacts = stmts.getContacts.all(user.id);
  const contactIds = new Set(contacts.map(c => c.contact_id));
  res.json(results.map(r => ({
    id: r.id,
    name: r.name,
    username: r.username,
    picture: r.picture,
    isContact: contactIds.has(r.id),
  })));
});

// ═══════════════════════════════════════════
// CONTACTS & FILE REQUESTS
// ═══════════════════════════════════════════

// Look up a user by handle
app.get('/api/user/:handle', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const handle = req.params.handle.toLowerCase();
  const target = stmts.findUserByUsername.get(handle);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === user.id) return res.status(400).json({ error: 'That\'s you!' });
  const contact = stmts.getContact.get(user.id, target.id);
  res.json({
    id: target.id,
    name: target.name,
    username: target.username,
    picture: target.picture,
    isContact: !!contact,
    contactAccess: contact ? contact.access : null,
    requestPref: target.request_pref || 'everyone',
  });
});

// Send a file request (or connection request)
app.post('/api/request', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { to, note } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient required' });

  // Look up by username or user ID
  const target = stmts.findUserByUsername.get(to) || stmts.findUserById.get(to);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === user.id) return res.status(400).json({ error: 'Cannot send to yourself' });

  // Check if blocked — show generic message (don't reveal block)
  const blocked = db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(target.id, user.id);
  if (blocked) {
    return res.status(403).json({ error: 'Request could not be sent' });
  }

  // Check recipient's request preference
  const pref = target.request_pref || 'everyone';
  if (pref === 'nobody') {
    return res.status(403).json({ error: 'This user is not accepting requests' });
  }
  if (pref === 'contacts') {
    const contact = stmts.getContact.get(target.id, user.id);
    if (!contact) {
      return res.status(403).json({ error: 'This user only accepts requests from contacts' });
    }
  }

  // Check if already a contact with "always" access — auto-accept
  const existingContact = stmts.getContact.get(target.id, user.id);
  if (existingContact && existingContact.access === 'always') {
    // Auto-accepted — add reverse contact too if not exists
    stmts.addContact.run(user.id, target.id);
    const reqId = stmts.createFileRequest.run(user.id, target.id, note || null).lastInsertRowid;
    stmts.setRequestStatus.run('accepted', reqId);
    // Notify via WebSocket
    notifyUser(target.id, { type: 'file-request', requestId: reqId, from: user.username, fromName: user.name, fromPicture: user.picture, note, autoAccepted: true });
    return res.json({ id: reqId, status: 'accepted', autoAccepted: true });
  }

  // Create pending request
  const reqId = stmts.createFileRequest.run(user.id, target.id, note || null).lastInsertRowid;
  // Notify via WebSocket
  notifyUser(target.id, { type: 'file-request', requestId: reqId, from: user.username, fromName: user.name, fromPicture: user.picture, note });
  res.json({ id: reqId, status: 'pending' });
});

// Get incoming requests
app.get('/api/requests', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const requests = stmts.getPendingRequests.all(user.id);
  res.json(requests);
});

// Accept a request
app.post('/api/request/:id/accept', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const request = stmts.getRequestById.get(req.params.id);
  if (!request || request.to_user_id !== user.id) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already handled' });

  stmts.setRequestStatus.run('accepted', request.id);

  // Add both users as contacts (mutual)
  stmts.addContact.run(user.id, request.from_user_id);
  stmts.addContact.run(request.from_user_id, user.id);

  // Notify the requester
  notifyUser(request.from_user_id, { type: 'request-accepted', requestId: request.id, by: user.username, byName: user.name, byPicture: user.picture });
  res.json({ status: 'accepted' });
});

// Decline a request
app.post('/api/request/:id/decline', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const request = stmts.getRequestById.get(req.params.id);
  if (!request || request.to_user_id !== user.id) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already handled' });

  stmts.setRequestStatus.run('declined', request.id);
  notifyUser(request.from_user_id, { type: 'request-declined', requestId: request.id });
  res.json({ status: 'declined' });
});

// Get contacts
app.get('/api/contacts', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const contacts = stmts.getContacts.all(user.id);
  res.json(contacts);
});

// Update contact access level
app.post('/api/contacts/:contactId/access', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { access } = req.body;
  if (!['always', 'ask', 'off'].includes(access)) return res.status(400).json({ error: 'Invalid access level' });
  stmts.updateContactAccess.run(access, user.id, req.params.contactId);
  res.json({ status: 'updated' });
});

// Remove a contact
app.delete('/api/contacts/:contactId', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  // Remove both directions
  stmts.deleteContact.run(user.id, req.params.contactId);
  stmts.deleteContact.run(req.params.contactId, user.id);
  res.json({ status: 'removed' });
});

// Block a contact — removes contact + prevents future requests
app.post('/api/contacts/:contactId/block', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  // Remove both directions
  stmts.deleteContact.run(user.id, req.params.contactId);
  stmts.deleteContact.run(req.params.contactId, user.id);
  // Add to blocks
  db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)').run(user.id, req.params.contactId);
  res.json({ status: 'blocked' });
});

// Get request preference
app.get('/api/settings/requests', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ pref: user.request_pref || 'everyone' });
});

// Update request preference
app.post('/api/settings/requests', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { pref } = req.body;
  if (!['everyone', 'contacts', 'nobody'].includes(pref)) return res.status(400).json({ error: 'Invalid preference' });
  stmts.setRequestPref.run(pref, user.id);
  res.json({ pref });
});

// Download pinned file
app.get('/api/pin/:id/download', async (req, res) => {
  if (!s3) return res.status(503).send('Storage not available');

  const pin = stmts.findPinnedFileById.get(req.params.id);
  if (!pin) return res.status(404).send('File not found');

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: pin.r2_key }));
    const safePinName = pin.filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    res.set({
      'Content-Type': pin.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safePinName}"; filename*=UTF-8''${encodeURIComponent(pin.filename)}`,
      'Content-Length': pin.file_size,
    });
    const stream = obj.Body;
    stream.on('data', (chunk) => res.write(chunk));
    stream.on('end', () => res.end());
    stream.on('error', () => res.end());
  } catch (err) {
    console.error('Pin download error:', err);
    res.status(500).send('Download failed');
  }
});

// ═══════════════════════════════════════════
// PROFILE PAGE
// ═══════════════════════════════════════════

function getProfilePage(user, pinnedFiles, validKey) {
  const profile = user.profile_data ? (typeof user.profile_data === 'string' ? JSON.parse(user.profile_data) : user.profile_data) : {};
  const bio = profile.bio || '';
  const links = profile.links || [];
  const canUpload = !!validKey;
  const recvLimits = getUserPlanLimits(user.id);
  const maxRecvSize = recvLimits.maxFileSize;
  const maxRecvLabel = maxRecvSize >= 1073741824 ? (maxRecvSize / 1073741824) + ' GB' : Math.round(maxRecvSize / 1048576) + ' MB';

  const socialIcons = {
    'twitter.com': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    'x.com': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    'linkedin.com': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
    'github.com': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>',
    'instagram.com': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678a6.162 6.162 0 100 12.324 6.162 6.162 0 100-12.324zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405a1.441 1.441 0 11-2.88 0 1.441 1.441 0 012.88 0z"/></svg>',
  };

  function getLinkIcon(url) {
    for (const [domain, svg] of Object.entries(socialIcons)) { if (url.includes(domain)) return svg; }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  }

  const bioHtml = bio ? `<p class="bio">${escapeHtml(bio).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#5b4cdb;text-decoration:none;">$1</a>')}</p>` : '';
  const linksHtml = links.length > 0 ? `<div class="social-row">${links.map(l => `<a class="social-icon" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${getLinkIcon(l.url)}</a>`).join('')}</div>` : '';
  const pinsHtml = pinnedFiles.length > 0 ? `
    <div class="section-label">Pinned</div>
    <div class="pinned-list">${pinnedFiles.map(f => `
      <a class="pinned-item" href="/api/pin/${f.id}/download">
        <div class="pin-icon">${escapeHtml((f.display_name || f.filename).split('.').pop().toUpperCase().slice(0,3))}</div>
        <div class="pin-details"><div class="pin-name">${escapeHtml(f.display_name || f.filename)}</div><div class="pin-meta">${formatBytes(f.file_size)}</div></div>
        <div class="pin-dl"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
      </a>`).join('')}
    </div>` : '';

  const userName = escapeHtml(user.name || user.username);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${userName} — Stickr</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',-apple-system,sans-serif;background:#fff;color:#1a1a1a;min-height:100vh}
.page{max-width:440px;margin:0 auto;padding:56px 20px 40px;position:relative;z-index:1}
.profile{text-align:center;margin-bottom:32px}
.avatar-ring{width:96px;height:96px;border-radius:50%;padding:3px;background:linear-gradient(135deg,#5b4cdb,#7c6fef);display:inline-block;margin-bottom:16px}
.avatar{width:100%;height:100%;border-radius:50%;object-fit:cover;background:#fff;border:3px solid #fff}
.name{font-family:'Instrument Serif',Georgia,serif;font-size:28px;font-weight:400;letter-spacing:-0.5px;margin-bottom:4px}
.handle{font-family:'JetBrains Mono','SF Mono','Fira Code',monospace;font-size:13px;color:#8a8a8a;margin-bottom:10px}
.bio{font-size:14px;color:#5a5a5a;line-height:1.6;max-width:320px;margin:0 auto 14px}
.social-row{display:flex;justify-content:center;gap:10px;margin-bottom:4px}
.social-icon{width:38px;height:38px;border-radius:10px;background:#fafaf8;border:1px solid #e0ddd4;display:flex;align-items:center;justify-content:center;color:#8a8a8a;text-decoration:none;transition:all .2s}
.social-icon:hover{border-color:#5b4cdb;color:#5b4cdb;transform:translateY(-2px)}
.drop-hint{text-align:center;padding:28px 20px;border:1.5px dashed #e0ddd4;border-radius:16px;margin-bottom:32px;cursor:pointer;transition:all .3s}
.drop-hint:hover{border-color:#5b4cdb;background:rgba(91,76,219,0.04)}
.drop-hint-icon{color:#8a8a8a;margin-bottom:10px;transition:color .3s}
.drop-hint:hover .drop-hint-icon{color:#5b4cdb}
.drop-hint h3{font-size:15px;font-weight:600;margin-bottom:4px}
.drop-hint p{font-size:12px;color:#8a8a8a}
.section-label{font-size:11px;font-weight:600;color:#8a8a8a;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px}
.pinned-list{display:flex;flex-direction:column;gap:8px;margin-bottom:32px}
.pinned-item{display:flex;align-items:center;gap:12px;padding:12px 14px;background:#fafaf8;border:1px solid #e0ddd4;border-radius:12px;cursor:pointer;transition:all .2s;text-decoration:none;color:#1a1a1a}
.pinned-item:hover{border-color:rgba(91,76,219,0.2);transform:translateX(3px)}
.pin-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;font-family:'SF Mono',monospace;flex-shrink:0;background:rgba(91,76,219,0.08);color:#5b4cdb}
.pin-details{flex:1;min-width:0}
.pin-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pin-meta{font-size:11px;color:#8a8a8a;margin-top:2px}
.pin-dl{width:32px;height:32px;border-radius:8px;background:rgba(91,76,219,0.08);display:flex;align-items:center;justify-content:center;color:#5b4cdb;flex-shrink:0}
.footer{text-align:center;padding-top:24px;border-top:1px solid #e0ddd4}
.footer-logo{font-family:'Instrument Serif',Georgia,serif;font-size:18px;font-weight:400;margin-bottom:4px;color:#1a1a1a}
.footer-logo em{font-style:italic;color:#5b4cdb}
.footer p{font-size:11px;color:#8a8a8a}
.footer a{color:#5b4cdb;text-decoration:none;font-weight:600}
.drop-target{display:none;position:fixed;inset:0;z-index:100;align-items:center;justify-content:center;background:rgba(255,255,255,0.92);backdrop-filter:blur(20px);border:3px dashed transparent}
.drop-target.active{display:flex;border-color:#5b4cdb;animation:borderPulse 1.5s ease infinite}
@keyframes borderPulse{0%,100%{border-color:#5b4cdb}50%{border-color:#7c6fef}}
.drop-target-content{text-align:center}
.drop-target-icon{width:80px;height:80px;border-radius:50%;background:rgba(91,76,219,0.08);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;color:#5b4cdb}
.drop-target h2{font-family:'Instrument Serif',Georgia,serif;font-size:24px;font-weight:400;margin-bottom:8px}
.drop-target p{color:#8a8a8a;font-size:14px}
.upload-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(255,255,255,0.85);backdrop-filter:blur(12px);z-index:200}
.upload-modal.active{display:flex}
.upload-modal-inner{background:#fafaf8;border:1px solid #e0ddd4;border-radius:20px;padding:36px;max-width:360px;width:90%;text-align:center}
.file-preview{display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(91,76,219,0.06);border-radius:10px;margin-bottom:20px;font-size:13px}
.file-preview .fname{flex:1;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-preview .fsize{color:#8a8a8a;font-size:12px;flex-shrink:0}
.upload-btn{width:100%;padding:14px;background:#5b4cdb;color:white;border:none;border-radius:12px;font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;cursor:pointer;transition:all .2s;margin-bottom:10px}
.upload-btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(91,76,219,0.2)}
.cancel-btn{background:none;border:none;color:#8a8a8a;font-family:inherit;font-size:13px;cursor:pointer}
.cancel-btn:hover{color:#1a1a1a}
.progress-bar-bg{width:100%;height:6px;background:#e0ddd4;border-radius:3px;overflow:hidden;margin:16px 0 12px}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,#5b4cdb,#7c6fef);border-radius:3px;width:0%;transition:width .3s}
.upload-state{display:none;text-align:center;padding:16px 0}
.upload-state.active{display:block}
.upload-state p{font-size:13px;color:#5a5a5a}
.success-check{width:56px;height:56px;border-radius:50%;background:rgba(45,159,111,0.08);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:#2d9f6f}
.send-another{margin-top:16px;background:none;border:1px solid #e0ddd4;color:#5a5a5a;padding:10px 24px;border-radius:10px;font-family:inherit;font-size:13px;cursor:pointer}
.send-another:hover{border-color:#5b4cdb;color:#1a1a1a}
.upload-error{color:#e8604c;font-size:13px;margin-top:12px;display:none}
.upload-error.show{display:block}
.no-upload{text-align:center;padding:20px;color:#8a8a8a;font-size:13px;margin-bottom:32px}
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
.profile{animation:fadeUp .5s ease both}
.drop-hint{animation:fadeUp .5s ease .1s both}
.pinned-list{animation:fadeUp .5s ease .2s both}
[data-theme="dark"] body{background:#0f0f12;color:#e8e6e1}
[data-theme="dark"] .name{color:#e8e6e1}
[data-theme="dark"] .handle{color:#6a6a72}
[data-theme="dark"] .bio{color:#9a9a9e}
[data-theme="dark"] .social-icon{background:#16161c;border-color:#2a2a34;color:#6a6a72}
[data-theme="dark"] .social-icon:hover{border-color:#7c6fef;color:#7c6fef}
[data-theme="dark"] .drop-hint{border-color:#2a2a34}
[data-theme="dark"] .drop-hint:hover{border-color:#7c6fef;background:rgba(124,111,239,0.06)}
[data-theme="dark"] .drop-hint h3{color:#e8e6e1}
[data-theme="dark"] .drop-hint p{color:#6a6a72}
[data-theme="dark"] .drop-hint-icon{color:#6a6a72}
[data-theme="dark"] .pinned-item{background:#16161c;border-color:#2a2a34;color:#e8e6e1}
[data-theme="dark"] .pinned-item:hover{border-color:rgba(124,111,239,0.3)}
[data-theme="dark"] .pin-meta{color:#6a6a72}
[data-theme="dark"] .section-label{color:#6a6a72}
[data-theme="dark"] .footer{border-color:#2a2a34}
[data-theme="dark"] .footer-logo{color:#e8e6e1}
[data-theme="dark"] .footer-logo em{color:#7c6fef}
[data-theme="dark"] .footer p{color:#6a6a72}
[data-theme="dark"] .footer a{color:#7c6fef}
[data-theme="dark"] .avatar{border-color:#0f0f12;background:#16161c}
[data-theme="dark"] .upload-modal{background:rgba(15,15,18,0.85)}
[data-theme="dark"] .upload-modal-inner{background:#16161c;border-color:#2a2a34}
[data-theme="dark"] .upload-modal-inner h3{color:#e8e6e1}
[data-theme="dark"] .send-another{border-color:#2a2a34;color:#9a9a9e}
[data-theme="dark"] .send-another:hover{border-color:#7c6fef;color:#e8e6e1}
[data-theme="dark"] .cancel-btn{color:#6a6a72}
[data-theme="dark"] .cancel-btn:hover{color:#e8e6e1}
[data-theme="dark"] .progress-bar-bg{background:#2a2a34}
[data-theme="dark"] .upload-state p{color:#9a9a9e}
[data-theme="dark"] .no-upload{color:#6a6a72}
[data-theme="dark"] .drop-target{background:rgba(15,15,18,0.92)}
[data-theme="dark"] .drop-target p{color:#6a6a72}
[data-theme="dark"] .theme-toggle{background:none;border:1px solid #2a2a34;color:#6a6a72}
[data-theme="dark"] .theme-toggle:hover{border-color:#7c6fef;color:#7c6fef}
</style><script>try{if(localStorage.getItem('stickr-theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}</script></head><body>
${DARK_MODE_TOGGLE_HTML}
${canUpload ? `<div class="drop-target" id="drop-target">
  <div class="drop-target-content">
    <div class="drop-target-icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
    <h2>Drop to send to ${userName}</h2>
    <p>Up to ${maxRecvLabel}</p>
  </div>
</div>
<div class="upload-modal" id="upload-modal">
  <div class="upload-modal-inner">
    <div id="upload-form">
      <h3 style="font-size:20px;font-weight:700;margin-bottom:16px">Send to ${userName}</h3>
      <div id="upload-file-list" style="max-height:200px;overflow-y:auto;margin-bottom:16px;"></div>
      <button class="upload-btn" id="upload-btn">Send file</button>
      <button class="cancel-btn" onclick="resetUpload()">Cancel</button>
      <div class="upload-error" id="upload-error"></div>
    </div>
    <div class="upload-state" id="upload-progress">
      <p id="progress-label" style="font-weight:600;margin-bottom:10px;">Sending to ${userName}...</p>
      <div class="progress-bar-bg"><div class="progress-bar-fill" id="progress-fill"></div></div>
      <p id="progress-text" style="margin-top:6px;">0%</p>
      <div id="recv-file-tracker" style="margin-top:12px;max-height:120px;overflow-y:auto;"></div>
    </div>
    <div class="upload-state" id="upload-success">
      <div class="success-check"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div>
      <h3 style="font-size:18px;margin-bottom:4px">Sent!</h3>
      <p id="success-msg">${userName} will find it in their inbox</p>
      <button class="send-another" onclick="resetUpload()">Send more files</button>
    </div>
  </div>
</div>` : ''}
<div class="page">
  <div class="profile">
    <div class="avatar-ring">${user.picture ? `<img class="avatar" src="${escapeHtml(user.picture)}" alt="">` : '<div class="avatar"></div>'}</div>
    <div class="name">${userName}</div>
    <div class="handle">@${escapeHtml(user.username)}</div>
    ${bioHtml}
    ${linksHtml}
  </div>
  ${canUpload ? `<div class="drop-hint" id="drop-hint" onclick="document.getElementById('recv-file-input').click()">
    <input type="file" id="recv-file-input" style="display:none" multiple>
    <div class="drop-hint-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
    <h3>Send files to ${userName}</h3>
    <p>Drop here or click to browse · up to ${maxRecvLabel} · zip folders before uploading</p>
  </div>` : ''}
  ${pinsHtml}
  ${!isProUser(user.id) ? `<div class="footer">
    <div class="footer-logo">St<em>i</em>ckr</div>
    <p>One link. Share everything. <a href="/">Get yours</a></p>
  </div>` : ''}
</div>
${canUpload ? `<script>
const LINK_ID='${validKey}';
const MAX_RECV=${maxRecvSize};
let pendingFile=null;
let dragCounter=0;
const dropTarget=document.getElementById('drop-target');
const modal=document.getElementById('upload-modal');

document.addEventListener('dragenter',e=>{e.preventDefault();dragCounter++;dropTarget.classList.add('active')});
document.addEventListener('dragleave',e=>{e.preventDefault();dragCounter--;if(dragCounter<=0){dragCounter=0;dropTarget.classList.remove('active')}});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{e.preventDefault();dragCounter=0;dropTarget.classList.remove('active');const files=Array.from(e.dataTransfer.files);if(files.length)startQueue(files)});
document.getElementById('recv-file-input').addEventListener('change',e=>{const files=Array.from(e.target.files);e.target.value='';if(files.length)startQueue(files)});

let uploadQueue=[];
let uploadIdx=0;
let currentBatchToken=null;

async function startQueue(files){
  uploadQueue=files.filter(f=>f.size<=MAX_RECV);
  if(uploadQueue.length===0){alert('All files are over ${maxRecvLabel} limit');return}
  if(uploadQueue.length<files.length){alert((files.length-uploadQueue.length)+' file(s) skipped — over ${maxRecvLabel} limit')}
  uploadIdx=0;
  currentBatchToken=null;
  // Create a batch if multiple files
  if(uploadQueue.length>1){
    try{
      const r=await fetch('/api/receive/batch',{method:'POST',headers:{'X-Receive-Link-Id':LINK_ID}});
      if(r.ok){const d=await r.json();currentBatchToken=d.token}
    }catch(e){}
  }
  showFileList();
}

function showFileList(){
  var list=document.getElementById('upload-file-list');
  var totalSize=uploadQueue.reduce(function(s,f){return s+f.size},0);
  list.innerHTML=uploadQueue.map(function(f,i){
    return '<div class="file-preview" style="margin-bottom:6px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5b4cdb" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="fname">'+f.name+'</span><span class="fsize">'+fmtSize(f.size)+'</span></div>';
  }).join('');
  document.getElementById('upload-btn').textContent=uploadQueue.length>1?'Send '+uploadQueue.length+' files ('+fmtSize(totalSize)+')':'Send file';
  document.getElementById('upload-form').style.display='';
  document.getElementById('upload-progress').classList.remove('active');
  document.getElementById('upload-success').classList.remove('active');
  document.getElementById('upload-error').classList.remove('show');
  modal.classList.add('active');
}

document.getElementById('upload-btn').addEventListener('click',doUploadAll);
modal.addEventListener('click',function(e){if(e.target===modal)resetUpload()});

async function doUploadAll(){
  document.getElementById('upload-form').style.display='none';
  var prog=document.getElementById('upload-progress');prog.classList.add('active');
  var fill=document.getElementById('progress-fill');
  var txt=document.getElementById('progress-text');
  var label=document.getElementById('progress-label');
  var tracker=document.getElementById('recv-file-tracker');
  var failed=0;

  // Build file tracker list
  tracker.innerHTML=uploadQueue.map(function(f,i){
    return '<div id="recv-tf-'+i+'" style="display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0;color:#8a8a8a;"><span id="recv-ti-'+i+'" style="width:14px;text-align:center;flex-shrink:0;">○</span><span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+f.name+'</span><span style="flex-shrink:0;font-size:11px;">'+fmtSize(f.size)+'</span></div>';
  }).join('');

  label.textContent='Sending '+uploadQueue.length+' file'+(uploadQueue.length>1?'s':'')+'...';

  for(uploadIdx=0;uploadIdx<uploadQueue.length;uploadIdx++){
    var file=uploadQueue[uploadIdx];
    var row=document.getElementById('recv-tf-'+uploadIdx);
    var icon=document.getElementById('recv-ti-'+uploadIdx);
    if(row)row.style.color='#1a1a1a';
    if(icon)icon.textContent='↑';
    try{
      await new Promise(function(resolve,reject){
        var xhr=new XMLHttpRequest();
        xhr.upload.addEventListener('progress',function(e){
          if(e.lengthComputable){
            var filePct=Math.round(e.loaded/e.total*100);
            var overallPct=Math.round(((uploadIdx+filePct/100)/uploadQueue.length)*100);
            fill.style.width=overallPct+'%';
            txt.textContent=(uploadIdx+1)+'/'+uploadQueue.length+' · '+filePct+'%';
          }
        });
        xhr.addEventListener('load',function(){
          if(xhr.status>=200&&xhr.status<300)resolve();
          else{try{reject(JSON.parse(xhr.responseText))}catch(e2){reject({error:'Upload failed'})}}
        });
        xhr.addEventListener('error',function(){reject({error:'Network error'})});
        xhr.open('POST','/api/receive/upload');
        xhr.setRequestHeader('X-Receive-Link-Id',LINK_ID);
        xhr.setRequestHeader('X-Filename',encodeURIComponent(file.name));
        xhr.setRequestHeader('X-Mime-Type',file.type||'application/octet-stream');
        if(currentBatchToken)xhr.setRequestHeader('X-Batch-Token',currentBatchToken);
        xhr.send(file);
      });
      if(icon){icon.textContent='✓';icon.style.color='#2d9f6f';}
      if(row)row.style.color='#8a8a8a';
    }catch(err){
      failed++;
      if(icon){icon.textContent='✕';icon.style.color='#e8604c';}
      console.error('Upload failed for '+file.name,err);
    }
  }

  prog.classList.remove('active');
  var sent=uploadQueue.length-failed;
  if(sent>0){
    document.getElementById('upload-success').classList.add('active');
    var msg=document.getElementById('success-msg');
    if(sent===1&&uploadQueue.length===1){
      msg.textContent='${userName} will find it in their inbox';
    }else if(failed>0){
      msg.textContent=sent+' of '+uploadQueue.length+' files sent to ${userName}';
    }else{
      msg.textContent=sent+' files sent to ${userName}';
    }
  }else{
    document.getElementById('upload-form').style.display='';
    document.getElementById('upload-error').textContent='All uploads failed. Please try again.';
    document.getElementById('upload-error').classList.add('show');
  }
}

function resetUpload(){modal.classList.remove('active');pendingFile=null;uploadQueue=[];uploadIdx=0;currentBatchToken=null;document.getElementById('progress-fill').style.width='0%'}
function fmtSize(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB'}
<\/script>` : ''}
${DARK_MODE_JS}
</body></html>`;
}

// Create a batch for grouping multiple files
app.post('/api/batch/create', rateLimit('batch', 20, 60 * 1000), (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const token = crypto.randomBytes(16).toString('hex');
  const planLimits = getUserPlanLimits(user.id);
  const expiresAt = new Date(Date.now() + planLimits.linkExpiry).toISOString();
  stmts.createBatch.run(token, user.id, expiresAt);

  const host = req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';

  res.json({ token, url: `${protocol}://${host}/dl/b/${token}`, expiresAt });
});

// Upload a file to R2 (authenticated, streams to R2)

app.post('/api/upload', rateLimit('upload', 20, 60 * 1000), async (req, res) => {
  if (!s3) return res.status(503).json({ error: 'Async transfers not available' });

  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  const mimeType = req.headers['x-mime-type'] || 'application/octet-stream';
  const declaredSize = parseInt(req.headers['content-length'], 10);

  if (!filename) {
    return res.status(400).json({ error: 'Missing filename' });
  }

  // Plan-based file size limit
  const planLimits = getUserPlanLimits(user.id);
  const effectiveMaxSize = planLimits.maxFileSize;
  if (declaredSize > effectiveMaxSize) {
    return res.status(413).json({ error: 'file_too_large', maxSize: effectiveMaxSize, plan: isProUser(user.id) ? 'pro' : 'free' });
  }

  // Quota enforcement — check remaining transfer allowance
  const quota = checkTransferQuota(user.id, declaredSize);
  if (!quota.allowed) {
    return res.status(413).json({
      error: 'quota_exceeded',
      remaining: quota.remaining,
      topupBalance: quota.topupBalance || 0,
      limit: quota.limit,
      source: quota.source,
      plan: isProUser(user.id) ? 'pro' : 'free',
    });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const r2Key = `${user.id}/${token}/${sanitizeFilename(filename)}`;
  const expiresAt = new Date(Date.now() + planLimits.linkExpiry).toISOString();

  // Track bytes as they stream through
  let bytesReceived = 0;
  const passthrough = new PassThrough();

  req.on('data', (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived > effectiveMaxSize) {
      passthrough.destroy(new Error('File too large'));
      req.destroy();
      return;
    }
    passthrough.write(chunk);
  });
  req.on('end', () => passthrough.end());
  req.on('error', (err) => passthrough.destroy(err));

  try {
    // Multipart streaming upload to R2
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
        Body: passthrough,
        ContentType: mimeType,
      },
      queueSize: 4,
      partSize: 10 * 1024 * 1024, // 10MB parts (200 parts for 2GB)
    });

    // Size-aware timeout: minimum 5 minutes, plus 1 second per MB
    // 100MB = 5 min, 500MB = ~13 min, 2GB = ~39 min (allows ~7 Mbps sustained)
    const timeoutMs = Math.max(5 * 60 * 1000, Math.ceil(declaredSize / (1024 * 1024)) * 1000 + 5 * 60 * 1000);
    const uploadTimeout = setTimeout(() => {
      upload.abort();
      passthrough.destroy(new Error('Upload timeout'));
      req.destroy();
    }, timeoutMs);

    await upload.done();
    clearTimeout(uploadTimeout);

    const fileSize = bytesReceived;

    // Record in database
    const batchToken = req.headers['x-batch-token'] || null;
    // Validate batch ownership — prevent cross-batch injection
    if (batchToken) {
      const batch = stmts.findBatch.get(batchToken);
      if (!batch || batch.user_id !== user.id) {
        // Invalid or someone else's batch — ignore the token
        stmts.createAsyncFile.run(token, user.id, filename, fileSize, mimeType, r2Key, expiresAt, null);
      } else {
        stmts.createAsyncFile.run(token, user.id, filename, fileSize, mimeType, r2Key, expiresAt, batchToken);
      }
    } else {
      stmts.createAsyncFile.run(token, user.id, filename, fileSize, mimeType, r2Key, expiresAt, null);
    }

    // Track transfer for stats
    const fileId = 'async-' + token;
    try { stmts.createPendingTransfer.run(fileId, user.id, fileSize); } catch {}

    // Track transfer usage against plan limits
    stmts.addTransferUsed.run(fileSize, user.id);

    // Deduct from appropriate balance based on quota source determined before upload
    // 'pro' = Pro monthly quota covers it, no balance deduction
    // 'topup_overflow' = Pro exhausted, using topup balance
    // 'balance' = free/topup user, deduct from balance
    if (quota.source !== 'pro') {
      stmts.deductBalance.run(fileSize, user.id, fileSize);
    }

    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const downloadUrl = `${protocol}://${host}/dl/${token}`;

    // If sending to a contact (X-Recipient header), put in their inbox
    const recipientId = req.headers['x-recipient'];
    if (recipientId) {
      const senderContact = stmts.getContact.get(user.id, recipientId);
      const recipientContact = stmts.getContact.get(recipientId, user.id);
      if (senderContact && recipientContact) {
        const recvToken = crypto.randomBytes(16).toString('hex');
        stmts.createReceivedFile.run(recvToken, recipientId, filename, fileSize, mimeType, r2Key, expiresAt, 'contact:' + user.id);
        notifyInbox(recipientId);
      }
    }

    res.json({
      token,
      url: downloadUrl,
      expiresAt,
    });
  } catch (err) {
    console.error('R2 upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Batch download page
app.get('/dl/b/:token', (req, res) => {
  const batch = stmts.findBatch.get(req.params.token);
  if (!batch) return res.status(404).send(getDownloadPage(null));

  if (new Date(batch.expires_at) < new Date()) {
    return res.status(410).send(getDownloadPage(null, true));
  }

  const files = stmts.findBatchFiles.all(req.params.token);
  if (files.length === 0) return res.status(404).send(getDownloadPage(null));

  res.send(getBatchDownloadPage(batch, files));
});

// Single file download page
app.get('/dl/:token', (req, res) => {
  const file = stmts.findAsyncFile.get(req.params.token);
  if (!file) {
    return res.status(404).send(getDownloadPage(null));
  }

  // Check expiry
  if (new Date(file.expires_at) < new Date()) {
    return res.status(410).send(getDownloadPage(null, true));
  }

  res.send(getDownloadPage(file));
});

// Actual file download (streams from R2)
app.get('/api/download/:token', async (req, res) => {
  if (!s3) return res.status(503).send('Async transfers not available');

  const file = stmts.findAsyncFile.get(req.params.token);
  if (!file) return res.status(404).send('File not found');

  if (new Date(file.expires_at) < new Date()) {
    return res.status(410).send('File expired');
  }

  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: file.r2_key,
    }));

    stmts.incrementDownloadCount.run(req.params.token);

    const safeName = file.filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    res.set({
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': file.file_size,
    });

    const stream = obj.Body;
    stream.on('data', (chunk) => res.write(chunk));
    stream.on('end', () => res.end());
    stream.on('error', (err) => {
      console.error('R2 stream error:', err);
      res.end();
    });
  } catch (err) {
    console.error('R2 download error:', err);
    res.status(500).send('Download failed');
  }
});

// Inline preview (serves file without Content-Disposition: attachment)
app.get('/api/preview/:token', async (req, res) => {
  if (!s3) return res.status(503).send('Not available');

  const file = stmts.findAsyncFile.get(req.params.token);
  if (!file) return res.status(404).send('File not found');
  if (new Date(file.expires_at) < new Date()) return res.status(410).send('Expired');

  // Only allow browser-renderable image previews
  const RAW_EXT = /\.(arw|cr2|cr3|nef|dng|raf|orf|rw2|pef|srw|x3f)$/i;
  if (!file.mime_type || !file.mime_type.startsWith('image/') || RAW_EXT.test(file.filename)) {
    return res.status(400).send('Preview not available');
  }

  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: file.r2_key,
    }));

    res.set({
      'Content-Type': file.mime_type,
      'Content-Length': file.file_size,
      'Cache-Control': 'private, max-age=3600',
    });

    const stream = obj.Body;
    stream.on('data', (chunk) => res.write(chunk));
    stream.on('end', () => res.end());
    stream.on('error', () => res.end());
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).send('Preview failed');
  }
});
// Dark mode support for server-rendered download pages
const DARK_MODE_CSS = `
[data-theme="dark"] body{background:#0f0f12;color:#e8e6e1}
[data-theme="dark"] .card{background:#16161c;border-color:#2a2a34}
[data-theme="dark"] .card-body{color:#e8e6e1}
[data-theme="dark"] h1{color:#e8e6e1}
[data-theme="dark"] .meta{color:#6a6a72}
[data-theme="dark"] .logo{color:#e8e6e1}
[data-theme="dark"] .logo em{color:#7c6fef}
[data-theme="dark"] .link-active{color:#6a6a72}
[data-theme="dark"] .expiry{color:#6a6a72}
[data-theme="dark"] .btn-outline{background:#1e1e26;color:#e8e6e1;border-color:#2a2a34}
[data-theme="dark"] .btn-outline:hover{border-color:#7c6fef;color:#7c6fef}
[data-theme="dark"] .btn-share{background:#1e1e26;color:#e8e6e1;border-color:#2a2a34}
[data-theme="dark"] .btn-share:hover{border-color:#7c6fef;color:#7c6fef}
[data-theme="dark"] .img-wrap{background:#16161c;border-color:#2a2a34}
[data-theme="dark"] .promo{border-color:#2a2a34}
[data-theme="dark"] .promo p{color:#6a6a72}
[data-theme="dark"] .promo a{color:#7c6fef}
[data-theme="dark"] .expiry-footer{border-color:#2a2a34}
[data-theme="dark"] .expiry-footer span{color:#6a6a72}
[data-theme="dark"] .file-row{background:#16161c;border-color:#2a2a34}
[data-theme="dark"] .file-row-name{color:#e8e6e1}
[data-theme="dark"] .file-row-size{color:#6a6a72}
[data-theme="dark"] .other-files-label{color:#6a6a72}
[data-theme="dark"] .fullscreen-overlay{background:rgba(0,0,0,0.95)}
[data-theme="dark"] .theme-toggle{background:none;border:1px solid #2a2a34;color:#6a6a72}
[data-theme="dark"] .theme-toggle:hover{border-color:#7c6fef;color:#7c6fef}
`;

const DARK_MODE_TOGGLE_HTML = `<button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode" style="position:fixed;top:16px;right:16px;z-index:100;background:none;border:1px solid #e0ddd4;border-radius:8px;padding:5px 7px;cursor:pointer;color:#8a8a8a;display:flex;align-items:center;justify-content:center;transition:all 0.2s;">
<svg id="ti-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
<svg id="ti-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
</button>`;

const DARK_MODE_JS = `<script>
function applyTheme(t){document.documentElement.setAttribute('data-theme',t);var s=document.getElementById('ti-sun'),m=document.getElementById('ti-moon');if(s&&m){s.style.display=t==='dark'?'':'none';m.style.display=t==='dark'?'none':''}var b=document.querySelector('.theme-toggle');if(b){b.style.borderColor=t==='dark'?'#2a2a34':'#e0ddd4';b.style.color=t==='dark'?'#6a6a72':'#8a8a8a'}}
function toggleTheme(){var c=document.documentElement.getAttribute('data-theme')||'light';var n=c==='dark'?'light':'dark';applyTheme(n);try{localStorage.setItem('stickr-theme',n)}catch(e){}}
try{var saved=localStorage.getItem('stickr-theme');if(saved==='dark')applyTheme('dark')}catch(e){}
<\/script>`;

function getDownloadPage(file, expired = false) {
  const sizeFormatted = file ? formatBytes(file.file_size) : '';
  const expiresIn = file ? getTimeRemaining(file.expires_at) : '';

  if (!file || expired) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stickr — File ${expired ? 'Expired' : 'Not Found'}</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',-apple-system,sans-serif;background:#fff;color:#1a1a1a;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:24px}
.card{background:#fafaf8;border:1px solid #e0ddd4;border-radius:16px;padding:48px 36px;max-width:420px;width:100%;text-align:center}
h1{font-family:'Instrument Serif',Georgia,serif;font-size:24px;font-weight:400;margin-bottom:8px}
p{color:#5a5a5a;font-size:14px;line-height:1.6;margin-bottom:24px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:14px 32px;border-radius:12px;font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;text-decoration:none;background:#5b4cdb;color:white;transition:all 0.2s}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(91,76,219,0.2)}
.logo{font-family:'Instrument Serif',Georgia,serif;font-size:28px;font-weight:400;margin-bottom:24px;color:#1a1a1a}
.logo em{font-style:italic;color:#5b4cdb}
.back-nav{width:100%;max-width:480px;margin-bottom:12px;}.back-link{display:inline-flex;align-items:center;gap:6px;color:#8a8a8a;text-decoration:none;font-size:13px;font-weight:500;transition:color .2s;}.back-link:hover{color:#5b4cdb}.back-link svg{flex-shrink:0}
${DARK_MODE_CSS}
</style><script>try{if(localStorage.getItem('stickr-theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}</script></head><body>
${DARK_MODE_TOGGLE_HTML}
<div class="card">
<div class="logo">St<em>i</em>ckr</div>
<h1>${expired ? 'File Expired' : 'File Not Found'}</h1>
<p>${expired ? 'This download link has expired. Ask the sender for a new link.' : 'This download link does not exist or has been removed.'}</p>
<a class="btn" href="/">Share files with Stickr</a>
</div>
${DARK_MODE_JS}
</body></html>`;
  }

  const RAW_EXTENSIONS = /\.(arw|cr2|cr3|nef|dng|raf|orf|rw2|pef|srw|x3f)$/i;
  const isImage = file.mime_type && file.mime_type.startsWith('image/') && !RAW_EXTENSIONS.test(file.filename);
  const showBranding = !isProUser(file.user_id);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stickr — ${isImage ? '' : 'Download '}${escapeHtml(file.filename)}</title>
${isImage ? `<meta property="og:image" content="/api/preview/${file.token}">` : ''}
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',-apple-system,sans-serif;background:#fff;color:#1a1a1a;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:24px}
.card{background:#fafaf8;border:1px solid #e0ddd4;border-radius:16px;max-width:${isImage ? '640px' : '420px'};width:100%;text-align:center;overflow:hidden}
.card-body{padding:${isImage ? '20px 28px 28px' : '48px 36px'}}
h1{font-family:'Instrument Serif',Georgia,serif;font-size:${isImage ? '16px' : '22px'};font-weight:400;margin-bottom:4px;word-break:break-all}
.meta{color:#8a8a8a;font-size:13px;margin-bottom:${isImage ? '16px' : '24px'}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px 32px;border-radius:12px;font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;text-decoration:none;background:#5b4cdb;color:white;transition:all 0.2s;margin-bottom:16px;border:none;cursor:pointer}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(91,76,219,0.2)}
.btn svg{flex-shrink:0}
.btn-row{display:flex;gap:10px;margin-bottom:12px}
.btn-row .btn{margin-bottom:0;flex:1}
.btn-share{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:14px 20px;border-radius:12px;font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;background:#f5f3ee;color:#1a1a1a;border:1px solid #e0ddd4;cursor:pointer;transition:all 0.2s}
.btn-share:hover{border-color:#5b4cdb;color:#5b4cdb}
.link-active{color:#8a8a8a;font-size:11px;text-align:center;margin-bottom:16px}
.logo{font-family:'Instrument Serif',Georgia,serif;font-size:28px;font-weight:400;margin-bottom:${isImage ? '0' : '24px'};color:#1a1a1a}
.logo em{font-style:italic;color:#5b4cdb}
.expiry{color:#8a8a8a;font-size:11px;margin-bottom:20px}
.promo{border-top:1px solid #e0ddd4;padding-top:20px;margin-top:8px}
.promo p{color:#8a8a8a;font-size:13px;margin-bottom:12px}
.promo a{color:#5b4cdb;text-decoration:none;font-weight:600;font-size:14px}
.promo a:hover{text-decoration:underline}
.file-icon{margin-bottom:16px}
.img-preview{width:100%;max-height:70vh;object-fit:contain;display:block;background:#f5f3ee;cursor:zoom-in}
.img-wrap{position:relative;background:#f5f3ee;border-bottom:1px solid #e0ddd4}
.img-wrap .logo{position:absolute;top:16px;left:20px;font-size:20px;z-index:1}
.fullscreen-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:1000;display:none;align-items:center;justify-content:center;cursor:zoom-out}
.fullscreen-overlay.active{display:flex}
.fullscreen-overlay img{max-width:95vw;max-height:95vh;object-fit:contain}
.back-nav{width:100%;max-width:480px;margin-bottom:12px;}.back-link{display:inline-flex;align-items:center;gap:6px;color:#8a8a8a;text-decoration:none;font-size:13px;font-weight:500;transition:color .2s;}.back-link:hover{color:#5b4cdb}.back-link svg{flex-shrink:0}
[data-theme="dark"] .img-preview{background:#16161c}
[data-theme="dark"] .img-wrap{background:#16161c;border-color:#2a2a34}
${DARK_MODE_CSS}
</style><script>try{if(localStorage.getItem('stickr-theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}</script></head><body>
${DARK_MODE_TOGGLE_HTML}
<div class="card">
${isImage ? `
<div class="img-wrap">
${showBranding ? '<div class="logo">St<em>i</em>ckr</div>' : ''}
<img class="img-preview" src="/api/preview/${file.token}" alt="${escapeHtml(file.filename)}" onclick="document.getElementById('fs').classList.add('active')" loading="lazy">
</div>
<div class="card-body">
<h1>${escapeHtml(file.filename)}</h1>
<p class="meta">${sizeFormatted}</p>
<div class="btn-row">
<a class="btn" href="/api/download/${file.token}">
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
Download
</a>
<button class="btn-share" onclick="if(navigator.share){navigator.share({title:'${escapeHtml(file.filename)}',url:location.href}).catch(function(){})}else{navigator.clipboard.writeText(location.href).then(function(){this.textContent='Copied!'})}">
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
Share
</button>
</div>
<div class="link-active">Link active for ${expiresIn}</div>
${showBranding ? '<div class="promo"><p>Want to share files too?</p><a href="/">Start free on Stickr</a></div>' : ''}
</div>
<div class="fullscreen-overlay" id="fs" onclick="this.classList.remove('active')">
<img src="/api/preview/${file.token}" alt="${escapeHtml(file.filename)}">
</div>
` : `
<div class="card-body">
${showBranding ? '<div class="logo">St<em>i</em>ckr</div>' : ''}
<div class="file-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#5b4cdb" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg></div>
<h1>${escapeHtml(file.filename)}</h1>
<p class="meta">${sizeFormatted}</p>
<div class="btn-row">
<a class="btn" href="/api/download/${file.token}">
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
Download
</a>
<button class="btn-share" onclick="if(navigator.share){navigator.share({title:'${escapeHtml(file.filename)}',url:location.href}).catch(function(){})}else{navigator.clipboard.writeText(location.href).then(function(){this.textContent='Copied!'})}">
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
Share
</button>
</div>
<div class="link-active">Link active for ${expiresIn}</div>
${showBranding ? '<div class="promo"><p>Want to share files too?</p><a href="/">Start free on Stickr</a></div>' : ''}
</div>
`}
</div>
${DARK_MODE_JS}
</body></html>`;
}


function getTimeRemaining(expiresAt) {
  const diff = new Date(expiresAt) - new Date();
  if (diff <= 0) return 'expired';
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return days + 'd ' + hours + 'h';
  if (hours > 0) return hours + 'h ' + minutes + 'm';
  return minutes + 'm';
}

function getBatchDownloadPage(batch, files) {
  const totalSize = files.reduce((sum, f) => sum + f.file_size, 0);
  const expiresIn = getTimeRemaining(batch.expires_at);
  const RAW_EXT = /\.(arw|cr2|cr3|nef|dng|raf|orf|rw2|pef|srw|x3f)$/i;
  const imageFiles = files.filter(f => f.mime_type && f.mime_type.startsWith('image/') && !RAW_EXT.test(f.filename));
  const otherFiles = files.filter(f => !f.mime_type || !f.mime_type.startsWith('image/') || RAW_EXT.test(f.filename));
  const imgCount = imageFiles.length;
  const showBranding = !isProUser(batch.user_id);

  const galleryData = imageFiles.map(f => ({
    src: '/api/preview/' + f.token,
    name: f.filename,
    dl: '/api/download/' + f.token
  }));

  const allFilesData = files.map(f => ({
    name: f.filename,
    dl: '/api/download/' + f.token
  }));

  const dlSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const dlSvg16 = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const shareSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

  const batchUrl = '/dl/b/' + batch.token;

  // Shared action buttons HTML
  const actionsHtml = files.length > 1 ? `
  <div class="album-actions">
    <button class="btn-primary" onclick="downloadAll()">${dlSvg16} Download all</button>
    <button class="btn-outline" id="zip-btn" onclick="downloadZip()">${dlSvg16} Zip</button>
    <button class="btn-outline" onclick="shareBatch()">${shareSvg} Share</button>
  </div>` : '';

  // Other files list
  const otherFilesHtml = otherFiles.length > 0 ? `
  ${imgCount > 0 ? '<div class="other-files-label">Other files</div>' : ''}
  ${otherFiles.map(f => `<div class="file-row"><div class="file-row-info"><div class="file-row-name">${escapeHtml(f.filename)}</div><div class="file-row-size">${formatBytes(f.file_size)}</div></div><a href="/api/download/${f.token}" class="file-row-btn album-dl">Download</a></div>`).join('')}` : '';

  // Build layout — one unified design for any file count
  const fileLabel = imgCount > 0
    ? `${imgCount} photo${imgCount > 1 ? 's' : ''}${otherFiles.length > 0 ? ' + ' + otherFiles.length + ' file' + (otherFiles.length > 1 ? 's' : '') : ''}`
    : `${files.length} file${files.length > 1 ? 's' : ''}`;

  const singleFileAction = files.length === 1 ? `
    <div class="album-actions">
      <a class="btn-primary" href="/api/download/${files[0].token}" download>${dlSvg16} Download</a>
      <button class="btn-outline" onclick="shareBatch()">${shareSvg} Share</button>
    </div>` : actionsHtml;

  const gridCols = imgCount === 1 ? 'grid-1' : imgCount <= 3 ? 'grid-2' : 'grid-3';
  const gridHtml = imageFiles.map((f, i) => `
    <div class="grid-item" style="animation-delay:${0.05 + i * 0.05}s" onclick="openGallery(${i})">
      <img src="/api/preview/${f.token}" alt="${escapeHtml(f.filename)}" loading="${i < 3 ? 'eager' : 'lazy'}">
      <div class="photo-overlay">
        <span class="photo-name">${escapeHtml(f.filename)}</span>
        <a href="/api/download/${f.token}" class="photo-dl album-dl" onclick="event.stopPropagation()">${dlSvg}</a>
      </div>
    </div>`).join('');

  const bodyHtml = `
  <div class="page">
    <div class="album-header">
      ${showBranding ? '<div class="logo">St<em>i</em>ckr</div>' : ''}
      <h1>${fileLabel}</h1>
      <p class="meta">${formatBytes(totalSize)}</p>
    </div>
    ${singleFileAction}
    ${imgCount > 0 ? `<div class="photo-grid ${gridCols}">${gridHtml}</div>` : ''}
    ${otherFilesHtml}
    <div class="expiry-footer"><span>Link active for ${expiresIn}</span></div>
    ${showBranding ? '<div class="promo"><p>Want to share files too?</p><a href="/">Try Stickr — it\'s free →</a></div>' : ''}
  </div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stickr — ${files.length} file${files.length > 1 ? 's' : ''}</title>
${imgCount > 0 ? `<meta property="og:image" content="/api/preview/${imageFiles[0].token}">` : ''}
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',-apple-system,sans-serif;background:#fff;color:#1a1a1a;min-height:100vh}
.back-nav{padding:16px 24px}
.back-link{display:inline-flex;align-items:center;gap:6px;color:#8a8a8a;text-decoration:none;font-size:13px;font-weight:500;transition:color .2s}
.back-link:hover{color:#5b4cdb}
h1{font-family:'Instrument Serif',Georgia,serif;font-weight:400}
.logo{font-family:'Instrument Serif',Georgia,serif;font-size:28px;font-weight:400;text-align:center;margin-bottom:4px;color:#1a1a1a}
.logo em{font-style:italic;color:#5b4cdb}
.meta{color:#8a8a8a;font-size:13px;text-align:center}

/* Unified page layout */
.page{max-width:720px;margin:0 auto;padding:0 24px 48px}
.album-header{text-align:center;margin-bottom:20px}
.album-header h1{font-size:24px;margin-bottom:4px}

/* Buttons */
.album-actions{display:flex;gap:10px;margin-bottom:24px;justify-content:center;flex-wrap:wrap}
.btn-primary{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px 28px;background:#5b4cdb;color:white;border:none;border-radius:12px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;text-decoration:none}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(91,76,219,0.25)}
.btn-outline{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;background:#f5f3ee;color:#1a1a1a;border:1px solid #e0ddd4;border-radius:12px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;text-decoration:none}
.btn-outline:hover{border-color:#5b4cdb;color:#5b4cdb}

/* Photo grid — responsive columns */
.photo-grid{column-gap:8px;margin-bottom:24px}
.grid-1{column-count:1;max-width:480px;margin-left:auto;margin-right:auto}
.grid-2{column-count:2}
.grid-3{column-count:3}
.grid-item{break-inside:avoid;margin-bottom:8px;position:relative;border-radius:12px;overflow:hidden;cursor:pointer;opacity:0;animation:fadeUp .4s ease forwards}
.grid-item img{width:100%;display:block;transition:transform .3s,opacity .2s}
.grid-item:hover img{transform:scale(1.03);opacity:.92}
.grid-item:hover .photo-overlay{opacity:1}

/* Photo overlay */
.photo-overlay{position:absolute;bottom:0;left:0;right:0;padding:10px 12px;background:linear-gradient(transparent,rgba(0,0,0,0.5));opacity:0;transition:opacity .2s;display:flex;align-items:center;justify-content:space-between}
.photo-name{font-size:11px;color:rgba(255,255,255,0.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.photo-dl{color:white;padding:4px;border-radius:6px;display:flex;text-decoration:none;transition:background .2s}
.photo-dl:hover{background:rgba(255,255,255,0.2)}

/* Other files */
.other-files-label{font-size:12px;font-weight:600;color:#8a8a8a;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;margin-top:8px}
.file-row{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:#fafaf8;border:1px solid #e0ddd4;border-radius:10px;margin-bottom:8px}
.file-row-info{min-width:0;flex:1}
.file-row-name{font-size:14px;font-weight:600;word-break:break-all}
.file-row-size{font-size:12px;color:#8a8a8a;margin-top:2px}
.file-row-btn{flex-shrink:0;margin-left:16px;padding:8px 16px;background:#5b4cdb;color:white;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;transition:all .2s}
.file-row-btn:hover{background:#4a3bc4}

.expiry-footer{text-align:center;padding:16px;margin-top:32px;border-top:1px solid #e0ddd4}
.expiry-footer span{font-size:12px;color:#8a8a8a}
.promo{text-align:center;padding-top:16px}
.promo p{color:#8a8a8a;font-size:13px;margin-bottom:8px}
.promo a{color:#5b4cdb;text-decoration:none;font-weight:600;font-size:14px}
.promo a:hover{text-decoration:underline}

/* Gallery */
.gallery{position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:1000;display:none;align-items:center;justify-content:center;flex-direction:column}
.gallery.active{display:flex}
.gallery-img{max-width:92vw;max-height:80vh;object-fit:contain;border-radius:4px}
.gallery-header{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:16px 20px;background:linear-gradient(rgba(0,0,0,0.5),transparent)}
.gallery-info{color:rgba(255,255,255,0.7);font-size:13px}
.gallery-counter{color:rgba(255,255,255,0.4);font-size:12px;margin-top:2px}
.gallery-actions{display:flex;gap:8px}
.gbtn{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,0.1);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s;text-decoration:none}
.gbtn:hover{background:rgba(255,255,255,0.25)}
.gnav{position:absolute;top:50%;transform:translateY(-50%);width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.08);border:none;color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;backdrop-filter:blur(8px)}
.gnav:hover{background:rgba(255,255,255,0.2)}
.gnav.prev{left:16px}
.gnav.next{right:16px}

@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}

@media(max-width:640px){
  .photo-grid.grid-3{column-count:2;column-gap:6px}
  .grid-item{margin-bottom:6px;border-radius:8px}
  .grid-item .photo-overlay{opacity:1}
  .page{padding:0 16px 36px}
  .gnav{display:none}
  .album-actions{flex-direction:column}
  .btn-primary,.btn-outline{width:100%;justify-content:center}
}
  .few-grid{gap:6px}
}
${DARK_MODE_CSS}
</style><script>try{if(localStorage.getItem('stickr-theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}</script></head><body>
${DARK_MODE_TOGGLE_HTML}
${bodyHtml}

${imgCount > 0 ? `
<div class="gallery" id="gallery">
  <div class="gallery-header">
    <div><div class="gallery-info" id="gname"></div><div class="gallery-counter" id="gctr"></div></div>
    <div class="gallery-actions">
      <a class="gbtn" id="gdl" href="#" title="Download"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>
      <button class="gbtn" onclick="closeGallery()" title="Close">✕</button>
    </div>
  </div>
  <img class="gallery-img" id="gimg" src="">
  <button class="gnav prev" onclick="gNav(-1)">‹</button>
  <button class="gnav next" onclick="gNav(1)">›</button>
</div>` : ''}

<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script>
var images=${JSON.stringify(galleryData)};
var allFiles=${JSON.stringify(allFilesData)};
var gIdx=0,tx=0;
function openGallery(i){gIdx=i;renderG();document.getElementById('gallery').classList.add('active');document.body.style.overflow='hidden'}
function closeGallery(){document.getElementById('gallery').classList.remove('active');document.body.style.overflow=''}
function gNav(d){gIdx=(gIdx+d+images.length)%images.length;renderG()}
function renderG(){var p=images[gIdx];document.getElementById('gimg').src=p.src;document.getElementById('gname').textContent=p.name;document.getElementById('gctr').textContent=(gIdx+1)+' / '+images.length;document.getElementById('gdl').href=p.dl;document.querySelectorAll('.gnav').forEach(function(n){n.style.display=images.length>1?'':'none'})}
document.addEventListener('keydown',function(e){if(!document.getElementById('gallery'))return;if(!document.getElementById('gallery').classList.contains('active'))return;if(e.key==='ArrowLeft')gNav(-1);else if(e.key==='ArrowRight')gNav(1);else if(e.key==='Escape')closeGallery()});
${imgCount > 0 ? `var g=document.getElementById('gallery');g.addEventListener('touchstart',function(e){tx=e.touches[0].clientX},{passive:true});g.addEventListener('touchend',function(e){var dx=e.changedTouches[0].clientX-tx;if(Math.abs(dx)>50){if(dx<0)gNav(1);else gNav(-1)}},{passive:true});g.addEventListener('click',function(e){if(e.target===g)closeGallery()});` : ''}
function downloadAll(){var links=document.querySelectorAll('.album-dl, .file-row-btn');links.forEach(function(a,i){setTimeout(function(){var el=document.createElement('a');el.href=a.href;el.download='';el.style.display='none';document.body.appendChild(el);el.click();document.body.removeChild(el)},i*800)})}
async function downloadZip(){var btn=document.getElementById('zip-btn');if(!btn)return;btn.disabled=true;btn.innerHTML='Preparing...';try{var zip=new JSZip();for(var i=0;i<allFiles.length;i++){btn.innerHTML=(i+1)+'/'+allFiles.length+'...';var resp=await fetch(allFiles[i].dl);var blob=await resp.blob();zip.file(allFiles[i].name,blob)}btn.innerHTML='Zipping...';var content=await zip.generateAsync({type:'blob'});var a=document.createElement('a');a.href=URL.createObjectURL(content);a.download='stickr-files.zip';a.click();URL.revokeObjectURL(a.href);btn.innerHTML='${dlSvg16} Zip';btn.disabled=false}catch(e){btn.innerHTML='Failed';btn.disabled=false;setTimeout(function(){btn.innerHTML='${dlSvg16} Zip'},2000)}}
function shareBatch(){if(navigator.share){navigator.share({title:'Stickr album',url:location.href}).catch(function(){})}else{navigator.clipboard.writeText(location.href).then(function(){alert('Link copied!')})}}
</script>
${DARK_MODE_JS}
</body></html>`;
}

app.use(express.static(path.join(__dirname, 'public')));
// TURN SESSION TOKENS
// ═══════════════════════════════════════════
const turnSessionTokens = new Map();
const TURN_SESSION_TOKEN_TTL = 2 * 60 * 60 * 1000;

function generateTurnSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of turnSessionTokens) {
    if (now - data.createdAt > TURN_SESSION_TOKEN_TTL) turnSessionTokens.delete(token);
  }
}, 10 * 60 * 1000);

// ICE servers endpoint
const iceRateLimit = new Map();
const ICE_RATE_LIMIT = 10;
const ICE_RATE_WINDOW = 60 * 1000;

app.get('/api/ice-servers', async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !turnSessionTokens.has(token)) {
    return res.status(403).json({ error: 'Invalid or missing session token' });
  }

  const ip = req.ip;
  const now = Date.now();
  let entry = iceRateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + ICE_RATE_WINDOW };
    iceRateLimit.set(ip, entry);
  }
  entry.count++;
  if (entry.count > ICE_RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const TURN_KEY_ID = process.env.TURN_KEY_ID;
  const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN;

  if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) {
    console.warn('TURN credentials not configured - returning STUN-only');
    return res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    });
  }

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 3600 }),
      }
    );
    if (!response.ok) throw new Error(`Cloudflare API returned ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Failed to fetch TURN credentials:', err.message);
    res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of iceRateLimit) {
    if (now > entry.resetAt) iceRateLimit.delete(ip);
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
// STATS + ANALYTICS
// ═══════════════════════════════════════════
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

// In-memory counters (reset on server restart)
const stats = {
  roomsCreated: 0,
  wsConnections: 0,
  peakConcurrentRooms: 0,
  peakConcurrentConnections: 0,
  serverStartedAt: new Date().toISOString(),
};

app.get('/api/stats', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user || user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const totalUsers = stmts.totalUsers.get();
  const totalTransfers = stmts.totalTransfers.get();
  const recentTransfers = stmts.recentTransfers.get();
  const topUsers = stmts.topUsers.all();
  const usersNearLimit = stmts.usersNearLimit.all();

  res.json({
    server: {
      uptime: Math.floor(process.uptime()),
      startedAt: stats.serverStartedAt,
      activeRooms: rooms.size,
      activeConnections: wss.clients.size,
      peakRooms: stats.peakConcurrentRooms,
      peakConnections: stats.peakConcurrentConnections,
      roomsCreatedSinceRestart: stats.roomsCreated,
    },
    users: {
      total: totalUsers.count,
      nearLimit: usersNearLimit,
    },
    transfers: {
      allTime: {
        count: totalTransfers.count,
        bytes: totalTransfers.total_bytes,
        formatted: formatBytes(totalTransfers.total_bytes),
      },
      last24h: {
        count: recentTransfers.count,
        bytes: recentTransfers.total_bytes,
        formatted: formatBytes(recentTransfers.total_bytes),
      },
    },
    topUsers: topUsers.map(u => ({
      email: u.email,
      name: u.name,
      balance: formatBytes(u.transfer_balance),
      transfers: u.transfers,
      sent: formatBytes(u.bytes_sent),
    })),
  });
});

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Plan limits
const PLAN_LIMITS = {
  free: {
    maxFileSize: 100 * 1024 * 1024,        // 100MB
    maxTransfer: 1 * 1024 * 1024 * 1024,    // 1GB (matches DB default)
    linkExpiry: 24 * 60 * 60 * 1000,       // 24 hours
    maxPins: 3,
    maxPinSize: 25 * 1024 * 1024,          // 25MB
    branding: true,
    canReceiveLink: false,
  },
  topup: {
    maxFileSize: 1 * 1024 * 1024 * 1024,   // 1GB
    maxTransfer: 10 * 1024 * 1024 * 1024,   // 10GB (from top-up purchase)
    linkExpiry: 24 * 60 * 60 * 1000,       // 24 hours
    maxPins: 3,
    maxPinSize: 25 * 1024 * 1024,          // 25MB
    branding: true,
    canReceiveLink: true,
  },
  pro: {
    maxFileSize: 2 * 1024 * 1024 * 1024,   // 2GB
    maxTransfer: 100 * 1024 * 1024 * 1024, // 100GB/month
    linkExpiry: 7 * 24 * 60 * 60 * 1000,   // 7 days
    maxPins: 3,
    maxPinSize: 25 * 1024 * 1024,          // 25MB
    branding: false,
    canReceiveLink: true,
  },
};

function getUserPlanLimits(userId) {
  const row = stmts.getUserPlan.get(userId);
  if (!row) return PLAN_LIMITS.free;
  // Pro (active subscription)
  if (row.plan === 'pro') {
    if (row.plan_expires_at && new Date(row.plan_expires_at) < new Date()) {
      // Pro expired — fall through to topup/free check
    } else {
      return PLAN_LIMITS.pro;
    }
  }
  // Top-up (has made any purchase)
  if (row.has_purchased) return PLAN_LIMITS.topup;
  return PLAN_LIMITS.free;
}

function isProUser(userId) {
  const row = stmts.getUserPlan.get(userId);
  if (!row || row.plan !== 'pro') return false;
  if (row.plan_expires_at && new Date(row.plan_expires_at) < new Date()) return false;
  return true;
}

// Check transfer quota — returns { allowed, remaining, used, limit, source }
function checkTransferQuota(userId, fileSize) {
  const limits = getUserPlanLimits(userId);
  const row = stmts.getUserPlan.get(userId);
  let used = row ? (row.transfer_used || 0) : 0;

  // Monthly reset for Pro users
  if (row && row.plan === 'pro' && row.transfer_used_reset) {
    const resetDate = new Date(row.transfer_used_reset);
    const now = new Date();
    if (now - resetDate > 30 * 24 * 60 * 60 * 1000) {
      stmts.resetTransferUsed.run(userId);
      used = 0;
    }
  }
  // First-time setup: set reset date if missing
  if (row && row.plan === 'pro' && !row.transfer_used_reset) {
    stmts.resetTransferUsed.run(userId);
    used = 0;
  }

  const proRemaining = Math.max(0, limits.maxTransfer - used);

  // Pro user with quota remaining — use monthly allowance
  if (isProUser(userId) && fileSize <= proRemaining) {
    return { allowed: true, remaining: proRemaining, used, limit: limits.maxTransfer, source: 'pro' };
  }

  // Pro user with quota exhausted — fall through to topup balance
  if (isProUser(userId) && proRemaining < fileSize) {
    const topupBalance = row ? (row.transfer_balance || 0) : 0;
    if (fileSize <= topupBalance) {
      return { allowed: true, remaining: topupBalance, used, limit: limits.maxTransfer, source: 'topup_overflow' };
    }
    // Neither Pro quota nor topup covers it
    return { allowed: false, remaining: proRemaining, topupBalance, used, limit: limits.maxTransfer, source: 'exhausted' };
  }

  // Free/topup users — balance-based
  const remaining = Math.max(0, limits.maxTransfer - used);
  const allowed = fileSize <= remaining;
  return { allowed, remaining, used, limit: limits.maxTransfer, source: 'balance' };
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeFilename(name) {
  if (!name) return 'unnamed';
  return name.replace(/\.\./g, '').replace(/[\/\\]/g, '_').replace(/[\x00-\x1f]/g, '').slice(0, 255) || 'unnamed';
}

// ═══════════════════════════════════════════
// FEEDBACK
// ═══════════════════════════════════════════
app.post('/api/feedback', rateLimit('feedback', 5, 60 * 1000), (req, res) => {
  const { text, email } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Feedback text required' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: 'Feedback too long' });
  }
  const user = getUserFromCookie(req);
  const userId = user ? user.id : null;
  const userEmail = email || (user ? user.email : null);

  db.prepare('INSERT INTO feedback (user_id, email, text) VALUES (?, ?, ?)').run(userId, userEmail, text.trim());
  console.log(`Feedback from ${userEmail || 'anonymous'}: ${text.trim().substring(0, 100)}`);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════
// HEALTH CHECK + SELF-PING
// ═══════════════════════════════════════════
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    rooms: rooms.size,
    uptime: Math.floor(process.uptime()),
  });
});

const SELF_PING_INTERVAL = 4 * 60 * 1000;
let selfPingTimer = null;

function startSelfPing() {
  const appUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
    : null;
  if (!appUrl) { console.log('No RAILWAY_PUBLIC_DOMAIN set - skipping self-ping'); return; }
  selfPingTimer = setInterval(async () => {
    try { await fetch(appUrl); } catch (e) { /* silent */ }
  }, SELF_PING_INTERVAL);
  console.log(`Self-ping active: ${appUrl} every ${SELF_PING_INTERVAL / 1000}s`);
}

// ═══════════════════════════════════════════
// ROOM MANAGEMENT
// ═══════════════════════════════════════════
const rooms = new Map();

function cleanupExistingRoom(ws) {
  if (!ws.roomId) return;
  const roomId = ws.roomId;
  const room = rooms.get(roomId);

  // Revoke TURN session token from prior room
  if (ws.turnSessionToken) {
    turnSessionTokens.delete(ws.turnSessionToken);
    ws.turnSessionToken = null;
  }

  if (!room) { ws.roomId = null; ws.role = null; return; }

  if (ws.role === 'host') {
    room.host = null;
    for (const [, peer] of room.peers) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({ type: 'host-disconnected' }));
      }
    }
    room.hostGraceTimer = setTimeout(() => {
      const r = rooms.get(roomId);
      if (r && !r.host) {
        for (const [, peer] of r.peers) {
          if (peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          }
        }
        rooms.delete(roomId);
      }
    }, 30000);
  } else {
    room.peers.delete(ws.id);
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      room.host.send(JSON.stringify({ type: 'peer-disconnected', peerId: ws.id }));
    }
  }
  ws.roomId = null;
  ws.role = null;
}

// Push inbox notification to a user's active WebSocket connections
function notifyInbox(userId) {
  const lastSeen = stmts.getLastInboxSeen.get(userId);
  const lastSeenTime = lastSeen && lastSeen.last_inbox_seen ? lastSeen.last_inbox_seen : '1970-01-01';
  const files = stmts.findReceivedFiles.all(userId);
  const count = files.filter(f => new Date(f.expires_at) > new Date() && f.created_at > lastSeenTime).length;
  let notified = 0;
  let withUser = 0;
  wss.clients.forEach((ws) => {
    if (ws.user) withUser++;
    if (ws.user && ws.user.id === userId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'inbox-update', count }));
      notified++;
    }
  });
  console.log(`Inbox notify: userId=${userId}, count=${count}, wsClients=${wss.clients.size}, withUser=${withUser}, notified=${notified}`);
}

// Send a WebSocket message to all connections for a specific user
function notifyUser(userId, msg) {
  wss.clients.forEach((ws) => {
    if (ws.user && ws.user.id === userId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });
}

// ═══════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════
wss.on('connection', (ws, req) => {
  ws.id = uuidv4();
  ws.isAlive = true;

  // Attach user from cookie if authenticated
  ws.user = getUserFromCookie(req);
  console.log(`WS connected: id=${ws.id}, user=${ws.user ? ws.user.email : 'anonymous'}, cookie=${req.headers.cookie ? 'yes' : 'no'}`);

  stats.wsConnections++;
  if (wss.clients.size > stats.peakConcurrentConnections) stats.peakConcurrentConnections = wss.clients.size;

  // TURN token issued on room join/create, not on connection
  ws.turnSessionToken = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        if (!ws.user) {
          ws.send(JSON.stringify({ type: 'error', message: 'auth-required' }));
          return;
        }
        // Cap total rooms to prevent memory abuse
        if (rooms.size >= 1000) {
          ws.send(JSON.stringify({ type: 'error', message: 'Server is busy, try again later' }));
          return;
        }
        // Cap rooms per user to 3
        let userRoomCount = 0;
        for (const [, room] of rooms) {
          if (room.hostUserId === ws.user.id) userRoomCount++;
        }
        if (userRoomCount >= 3) {
          ws.send(JSON.stringify({ type: 'error', message: 'Too many active rooms' }));
          return;
        }
        cleanupExistingRoom(ws);
        const roomId = generateRoomId();
        rooms.set(roomId, { host: ws, hostId: ws.id, hostUserId: ws.user.id, peers: new Map() });
        ws.roomId = roomId;
        ws.role = 'host';
        // Issue TURN token now that user is in a room
        const wsToken = generateTurnSessionToken();
        turnSessionTokens.set(wsToken, { peerId: ws.id, createdAt: Date.now() });
        ws.turnSessionToken = wsToken;
        ws.send(JSON.stringify({ type: 'session-token', token: wsToken }));
        ws.send(JSON.stringify({ type: 'room-created', roomId, peerId: ws.id }));
        stats.roomsCreated++;
        if (rooms.size > stats.peakConcurrentRooms) stats.peakConcurrentRooms = rooms.size;
        break;
      }

      case 'join-room': {
        cleanupExistingRoom(ws);
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        ws.roomId = msg.roomId;
        ws.role = 'peer';
        room.peers.set(ws.id, ws);
        // Issue TURN token now that peer is in a room
        const joinToken = generateTurnSessionToken();
        turnSessionTokens.set(joinToken, { peerId: ws.id, createdAt: Date.now() });
        ws.turnSessionToken = joinToken;
        ws.send(JSON.stringify({ type: 'session-token', token: joinToken }));
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'room-joined', roomId: msg.roomId, peerId: ws.id, hostId: room.hostId }));
          room.host.send(JSON.stringify({ type: 'peer-joined', peerId: ws.id }));
        } else {
          ws.send(JSON.stringify({ type: 'room-joined', roomId: msg.roomId, peerId: ws.id, hostId: room.hostId }));
        }
        break;
      }

      case 'rejoin-host': {
        if (!ws.user) {
          ws.send(JSON.stringify({ type: 'error', message: 'auth-required' }));
          return;
        }
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        // Verify this is the original host
        if (room.hostUserId !== ws.user.id) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authorized to rejoin as host' }));
          return;
        }
        if (room.hostGraceTimer) {
          clearTimeout(room.hostGraceTimer);
          room.hostGraceTimer = null;
        }
        room.host = ws;
        room.hostId = ws.id;
        ws.roomId = msg.roomId;
        ws.role = 'host';
        // Issue fresh TURN token on rejoin
        const rejoinToken = generateTurnSessionToken();
        turnSessionTokens.set(rejoinToken, { peerId: ws.id, createdAt: Date.now() });
        ws.turnSessionToken = rejoinToken;
        ws.send(JSON.stringify({ type: 'session-token', token: rejoinToken }));
        ws.send(JSON.stringify({ type: 'rejoin-confirmed', roomId: msg.roomId, peerId: ws.id }));
        for (const [peerId, peer] of room.peers) {
          if (peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({ type: 'host-reconnected', hostId: ws.id }));
            ws.send(JSON.stringify({ type: 'peer-joined', peerId }));
          }
        }
        break;
      }

      case 'signal': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const target = msg.to === room.hostId
          ? room.host
          : room.peers.get(msg.to);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ type: 'signal', from: ws.id, signal: msg.signal }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.turnSessionToken) turnSessionTokens.delete(ws.turnSessionToken);
    cleanupExistingRoom(ws);
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(id));
  return id;
}

// Profile page catch-all (MUST be the very last route)
app.get('/:username', (req, res) => {
  const username = req.params.username.toLowerCase();
  if (RESERVED_USERNAMES.has(username)) return res.status(404).send('Not found');

  const user = stmts.findUserByUsername.get(username);
  if (!user) return res.status(404).send('Not found');

  // Validate upload key if provided
  const key = req.query.key || null;
  let validKey = null;
  if (key) {
    const link = stmts.findReceiveLinkById.get(key);
    if (link && link.active && link.user_id === user.id && new Date(link.expires_at) > new Date()) {
      validKey = key;
    }
  }

  const pinnedFiles = stmts.findPinnedFilesByUsername.all(username);
  res.send(getProfilePage(user, pinnedFiles, validKey));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Stickr server running on http://localhost:${PORT}`);
  startSelfPing();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
