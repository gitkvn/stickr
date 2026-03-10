const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const cookie = require('cookie');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
const ASYNC_THRESHOLD = 25 * 1024 * 1024; // 25MB
const MAX_FILE_SIZE = 250 * 1024 * 1024; // 250MB per file (free tier)

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
    transfer_balance INTEGER DEFAULT 524288000,
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
`);

// Migrate: add columns if missing
try { db.exec('ALTER TABLE async_files ADD COLUMN batch_token TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE async_files ADD COLUMN receive_link_id TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN username TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN profile_data TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN last_inbox_seen TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE pinned_files ADD COLUMN display_name TEXT'); } catch (e) { /* already exists */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)'); } catch (e) { /* already exists */ }

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
// RECEIVE LINKS + INBOX
// ═══════════════════════════════════════════

// Generate a new upload link
app.post('/api/receive-link/create', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (!user.username) return res.status(400).json({ error: 'No username set' });

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

// Upload to someone's profile (passcode verified, no auth needed for sender)
app.post('/api/receive/upload', rateLimit('receive-upload', 10, 60 * 1000), async (req, res) => {
  if (!s3) return res.status(503).json({ error: 'Storage not available' });

  const linkId = req.headers['x-receive-link-id'];
  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  const mimeType = req.headers['x-mime-type'] || 'application/octet-stream';
  const declaredSize = parseInt(req.headers['content-length'], 10);

  if (!linkId || !filename) return res.status(400).json({ error: 'Missing link ID or filename' });

  const link = stmts.findReceiveLinkById.get(linkId);
  if (!link || !link.active) return res.status(403).json({ error: 'Invalid receive link' });
  if (new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired' });

  const MAX_RECEIVE_SIZE = 100 * 1024 * 1024; // 100MB for received files
  if (declaredSize > MAX_RECEIVE_SIZE) {
    return res.status(413).json({ error: 'File too large (max 100 MB)' });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const r2Key = `received/${link.user_id}/${token}/${sanitizeFilename(filename)}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 day expiry for received files

  let bytesReceived = 0;
  const passthrough = new PassThrough();

  req.on('data', (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived > MAX_RECEIVE_SIZE) {
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

    await upload.done();

    stmts.createReceivedFile.run(token, link.user_id, filename, bytesReceived, mimeType, r2Key, expiresAt, link.id);

    // Push inbox notification via WebSocket
    notifyInbox(link.user_id);

    res.json({ success: true });
  } catch (err) {
    console.error('Receive upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Inbox — list received files
app.get('/api/inbox', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const files = stmts.findReceivedFiles.all(user.id);
  const active = files.filter(f => new Date(f.expires_at) > new Date());
  res.json(active);
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

  const count = stmts.countPinnedFiles.get(user.id);
  if (count.count >= 3) return res.status(400).json({ error: 'Maximum 3 pinned files' });

  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  const displayName = decodeURIComponent(req.headers['x-display-name'] || '') || filename;
  const mimeType = req.headers['x-mime-type'] || 'application/octet-stream';
  const declaredSize = parseInt(req.headers['content-length'], 10);

  if (!filename) return res.status(400).json({ error: 'Missing filename' });

  const MAX_PIN_SIZE = 25 * 1024 * 1024;
  if (declaredSize > MAX_PIN_SIZE) {
    return res.status(413).json({ error: 'Pinned files must be under 25 MB' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const r2Key = `pinned/${user.id}/${id}/${sanitizeFilename(filename)}`;

  let bytesReceived = 0;
  const passthrough = new PassThrough();

  req.on('data', (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived > MAX_PIN_SIZE) {
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

    await upload.done();

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

  const bioHtml = bio ? `<p class="bio">${escapeHtml(bio)}</p>` : '';
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
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:#08080c;color:#e8e8f0;min-height:100vh}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 600px 400px at 30% 15%,rgba(108,92,231,0.05) 0%,transparent 70%),radial-gradient(ellipse 500px 300px at 75% 85%,rgba(0,210,160,0.03) 0%,transparent 70%);pointer-events:none}
.page{max-width:440px;margin:0 auto;padding:56px 20px 40px;position:relative;z-index:1}
.profile{text-align:center;margin-bottom:32px}
.avatar-ring{width:96px;height:96px;border-radius:50%;padding:3px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);display:inline-block;margin-bottom:16px}
.avatar{width:100%;height:100%;border-radius:50%;object-fit:cover;background:#08080c;border:3px solid #08080c}
.name{font-size:28px;font-weight:700;letter-spacing:-0.5px;margin-bottom:4px}
.handle{font-family:'SF Mono','Fira Code',monospace;font-size:13px;color:#555570;margin-bottom:10px}
.bio{font-size:14px;color:#8888a8;line-height:1.6;max-width:320px;margin:0 auto 14px}
.social-row{display:flex;justify-content:center;gap:10px;margin-bottom:4px}
.social-icon{width:38px;height:38px;border-radius:10px;background:#101018;border:1px solid #1a1a28;display:flex;align-items:center;justify-content:center;color:#555570;text-decoration:none;transition:all .2s}
.social-icon:hover{border-color:#6c5ce7;color:#a29bfe;transform:translateY(-2px)}
.drop-hint{text-align:center;padding:28px 20px;border:1.5px dashed #1a1a28;border-radius:16px;margin-bottom:32px;cursor:pointer;transition:all .3s}
.drop-hint:hover{border-color:#6c5ce7;background:rgba(108,92,231,0.04)}
.drop-hint-icon{color:#555570;margin-bottom:10px;transition:color .3s}
.drop-hint:hover .drop-hint-icon{color:#a29bfe}
.drop-hint h3{font-size:15px;font-weight:600;margin-bottom:4px}
.drop-hint p{font-size:12px;color:#555570}
.section-label{font-size:11px;font-weight:600;color:#555570;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px}
.pinned-list{display:flex;flex-direction:column;gap:8px;margin-bottom:32px}
.pinned-item{display:flex;align-items:center;gap:12px;padding:12px 14px;background:#101018;border:1px solid #1a1a28;border-radius:12px;cursor:pointer;transition:all .2s;text-decoration:none;color:#e8e8f0}
.pinned-item:hover{border-color:rgba(108,92,231,0.3);transform:translateX(3px)}
.pin-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;font-family:'SF Mono',monospace;flex-shrink:0;background:rgba(108,92,231,0.1);color:#a29bfe}
.pin-details{flex:1;min-width:0}
.pin-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pin-meta{font-size:11px;color:#555570;margin-top:2px}
.pin-dl{width:32px;height:32px;border-radius:8px;background:rgba(108,92,231,0.1);display:flex;align-items:center;justify-content:center;color:#a29bfe;flex-shrink:0}
.footer{text-align:center;padding-top:24px;border-top:1px solid #1a1a28}
.footer-logo{font-size:16px;font-weight:800;margin-bottom:4px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.footer p{font-size:11px;color:#555570}
.footer a{color:#a29bfe;text-decoration:none;font-weight:600}
.drop-target{display:none;position:fixed;inset:0;z-index:100;align-items:center;justify-content:center;background:rgba(8,8,12,0.92);backdrop-filter:blur(20px);border:3px dashed transparent}
.drop-target.active{display:flex;border-color:#6c5ce7;animation:borderPulse 1.5s ease infinite}
@keyframes borderPulse{0%,100%{border-color:#6c5ce7}50%{border-color:#a29bfe}}
.drop-target-content{text-align:center}
.drop-target-icon{width:80px;height:80px;border-radius:50%;background:rgba(108,92,231,0.15);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;color:#a29bfe}
.drop-target h2{font-size:24px;font-weight:700;margin-bottom:8px}
.drop-target p{color:#555570;font-size:14px}
.upload-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(8,8,12,0.85);backdrop-filter:blur(12px);z-index:200}
.upload-modal.active{display:flex}
.upload-modal-inner{background:#101018;border:1px solid #1a1a28;border-radius:20px;padding:36px;max-width:360px;width:90%;text-align:center}
.file-preview{display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(108,92,231,0.08);border-radius:10px;margin-bottom:20px;font-size:13px}
.file-preview .fname{flex:1;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-preview .fsize{color:#555570;font-size:12px;flex-shrink:0}
.upload-btn{width:100%;padding:14px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:white;border:none;border-radius:12px;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;transition:all .2s;margin-bottom:10px}
.upload-btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(108,92,231,0.3)}
.cancel-btn{background:none;border:none;color:#555570;font-family:inherit;font-size:13px;cursor:pointer}
.cancel-btn:hover{color:#e8e8f0}
.progress-bar-bg{width:100%;height:6px;background:#1a1a28;border-radius:3px;overflow:hidden;margin:16px 0 12px}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,#6c5ce7,#a29bfe);border-radius:3px;width:0%;transition:width .3s}
.upload-state{display:none;text-align:center;padding:16px 0}
.upload-state.active{display:block}
.upload-state p{font-size:13px;color:#8888a8}
.success-check{width:56px;height:56px;border-radius:50%;background:rgba(0,210,160,0.12);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:#00d2a0}
.send-another{margin-top:16px;background:none;border:1px solid #1a1a28;color:#8888a8;padding:10px 24px;border-radius:10px;font-family:inherit;font-size:13px;cursor:pointer}
.send-another:hover{border-color:#6c5ce7;color:#e8e8f0}
.upload-error{color:#e05555;font-size:13px;margin-top:12px;display:none}
.upload-error.show{display:block}
.no-upload{text-align:center;padding:20px;color:#555570;font-size:13px;margin-bottom:32px}
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
.profile{animation:fadeUp .5s ease both}
.drop-hint{animation:fadeUp .5s ease .1s both}
.pinned-list{animation:fadeUp .5s ease .2s both}
</style></head><body>
${canUpload ? `<div class="drop-target" id="drop-target">
  <div class="drop-target-content">
    <div class="drop-target-icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
    <h2>Drop to send to ${userName}</h2>
    <p>Up to 100 MB</p>
  </div>
</div>
<div class="upload-modal" id="upload-modal">
  <div class="upload-modal-inner">
    <div id="upload-form">
      <h3 style="font-size:20px;font-weight:700;margin-bottom:16px">Send to ${userName}</h3>
      <div class="file-preview" id="file-preview">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a29bfe" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="fname" id="p-fname"></span>
        <span class="fsize" id="p-fsize"></span>
      </div>
      <button class="upload-btn" id="upload-btn">Send file</button>
      <button class="cancel-btn" onclick="document.getElementById('upload-modal').classList.remove('active')">Cancel</button>
      <div class="upload-error" id="upload-error"></div>
    </div>
    <div class="upload-state" id="upload-progress">
      <p>Sending to ${userName}...</p>
      <div class="progress-bar-bg"><div class="progress-bar-fill" id="progress-fill"></div></div>
      <p id="progress-text">0%</p>
    </div>
    <div class="upload-state" id="upload-success">
      <div class="success-check"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div>
      <h3 style="font-size:18px;margin-bottom:4px">Sent!</h3>
      <p>${userName} will find it in their inbox</p>
      <button class="send-another" onclick="resetUpload()">Send another file</button>
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
    <input type="file" id="recv-file-input" style="display:none">
    <div class="drop-hint-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
    <h3>Send files to ${userName}</h3>
    <p>Drop here or click to browse · up to 100 MB</p>
  </div>` : ''}
  ${pinsHtml}
  <div class="footer">
    <div class="footer-logo">Stickr</div>
    <p>One link. Share everything. <a href="/">Get yours</a></p>
  </div>
</div>
${canUpload ? `<script>
const LINK_ID='${validKey}';
const MAX_RECV=100*1024*1024;
let pendingFile=null;
let dragCounter=0;
const dropTarget=document.getElementById('drop-target');
const modal=document.getElementById('upload-modal');

document.addEventListener('dragenter',e=>{e.preventDefault();dragCounter++;dropTarget.classList.add('active')});
document.addEventListener('dragleave',e=>{e.preventDefault();dragCounter--;if(dragCounter<=0){dragCounter=0;dropTarget.classList.remove('active')}});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{e.preventDefault();dragCounter=0;dropTarget.classList.remove('active');const f=e.dataTransfer.files[0];if(f)showUpload(f)});
document.getElementById('recv-file-input').addEventListener('change',e=>{const f=e.target.files[0];e.target.value='';if(f)showUpload(f)});

function showUpload(file){
  if(file.size>MAX_RECV){alert('File too large (max 100 MB)');return}
  pendingFile=file;
  document.getElementById('p-fname').textContent=file.name;
  document.getElementById('p-fsize').textContent=fmtSize(file.size);
  document.getElementById('upload-form').style.display='';
  document.getElementById('upload-progress').classList.remove('active');
  document.getElementById('upload-success').classList.remove('active');
  document.getElementById('upload-error').classList.remove('show');
  modal.classList.add('active');
}

document.getElementById('upload-btn').addEventListener('click',doUpload);
modal.addEventListener('click',e=>{if(e.target===modal){modal.classList.remove('active');pendingFile=null}});

async function doUpload(){
  if(!pendingFile)return;
  document.getElementById('upload-form').style.display='none';
  const prog=document.getElementById('upload-progress');prog.classList.add('active');
  const fill=document.getElementById('progress-fill');const txt=document.getElementById('progress-text');
  try{
    const xhr=new XMLHttpRequest();
    await new Promise((resolve,reject)=>{
      xhr.upload.addEventListener('progress',e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);fill.style.width=p+'%';txt.textContent=p+'%'}});
      xhr.addEventListener('load',()=>{if(xhr.status>=200&&xhr.status<300)resolve(JSON.parse(xhr.responseText));else{try{reject(JSON.parse(xhr.responseText))}catch{reject({error:'Upload failed'})}}});
      xhr.addEventListener('error',()=>reject({error:'Network error'}));
      xhr.open('POST','/api/receive/upload');
      xhr.setRequestHeader('X-Receive-Link-Id',LINK_ID);
      xhr.setRequestHeader('X-Filename',encodeURIComponent(pendingFile.name));
      xhr.setRequestHeader('X-Mime-Type',pendingFile.type||'application/octet-stream');
      xhr.send(pendingFile);
    });
    prog.classList.remove('active');
    document.getElementById('upload-success').classList.add('active');
  }catch(err){
    prog.classList.remove('active');
    document.getElementById('upload-form').style.display='';
    document.getElementById('upload-error').textContent=err.error||'Upload failed';
    document.getElementById('upload-error').classList.add('show');
  }
}

function resetUpload(){modal.classList.remove('active');pendingFile=null;document.getElementById('progress-fill').style.width='0%'}
function fmtSize(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB'}
<\/script>` : ''}
</body></html>`;
}

// Create a batch for grouping multiple files
app.post('/api/batch/create', rateLimit('batch', 20, 60 * 1000), (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + ASYNC_FILE_EXPIRY).toISOString();
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

  if (declaredSize > MAX_FILE_SIZE) {
    return res.status(413).json({ error: 'file_too_large', maxSize: MAX_FILE_SIZE });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const r2Key = `${user.id}/${token}/${sanitizeFilename(filename)}`;
  const expiresAt = new Date(Date.now() + ASYNC_FILE_EXPIRY).toISOString();

  // Track bytes as they stream through
  let bytesReceived = 0;
  const passthrough = new PassThrough();

  req.on('data', (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived > MAX_FILE_SIZE) {
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
      partSize: 5 * 1024 * 1024, // 5MB parts
    });

    await upload.done();

    const fileSize = bytesReceived;

    // Record in database
    const batchToken = req.headers['x-batch-token'] || null;
    stmts.createAsyncFile.run(token, user.id, filename, fileSize, mimeType, r2Key, expiresAt, batchToken);

    // Track transfer for stats
    const fileId = 'async-' + token;
    try { stmts.createPendingTransfer.run(fileId, user.id, fileSize); } catch {}

    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const downloadUrl = `${protocol}://${host}/dl/${token}`;

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

// Download page HTML generator
function getDownloadPage(file, expired = false) {
  const sizeFormatted = file ? formatBytes(file.file_size) : '';
  const expiresIn = file ? getTimeRemaining(file.expires_at) : '';

  if (!file || expired) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stickr — File ${expired ? 'Expired' : 'Not Found'}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:24px}
.card{background:#12121a;border:1px solid #2a2a3e;border-radius:16px;padding:48px 36px;max-width:420px;width:100%;text-align:center}
h1{font-size:24px;margin-bottom:8px}
p{color:#8888a8;font-size:14px;line-height:1.6;margin-bottom:24px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:14px 32px;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:white;transition:all 0.2s}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px #6c5ce730}
.logo{font-size:28px;font-weight:800;margin-bottom:24px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
</style></head><body>
<div class="card">
<div class="logo">Stickr</div>
<h1>${expired ? 'File Expired' : 'File Not Found'}</h1>
<p>${expired ? 'This download link has expired. Ask the sender for a new link.' : 'This download link does not exist or has been removed.'}</p>
<a class="btn" href="/">Share files with Stickr</a>
</div></body></html>`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stickr — Download ${escapeHtml(file.filename)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:24px}
.card{background:#12121a;border:1px solid #2a2a3e;border-radius:16px;padding:48px 36px;max-width:420px;width:100%;text-align:center}
h1{font-size:20px;margin-bottom:4px;word-break:break-all}
.meta{color:#8888a8;font-size:13px;margin-bottom:24px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:16px 32px;border-radius:12px;font-size:16px;font-weight:600;text-decoration:none;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:white;transition:all 0.2s;margin-bottom:16px;border:none;cursor:pointer}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px #6c5ce730}
.btn svg{flex-shrink:0}
.logo{font-size:28px;font-weight:800;margin-bottom:24px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.expiry{color:#555570;font-size:11px;margin-bottom:20px}
.promo{border-top:1px solid #2a2a3e;padding-top:20px;margin-top:8px}
.promo p{color:#8888a8;font-size:13px;margin-bottom:12px}
.promo a{color:#a29bfe;text-decoration:none;font-weight:600;font-size:14px}
.promo a:hover{text-decoration:underline}
.file-icon{margin-bottom:16px}
</style></head><body>
<div class="card">
<div class="logo">Stickr</div>
<div class="file-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#a29bfe" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg></div>
<h1>${escapeHtml(file.filename)}</h1>
<p class="meta">${sizeFormatted}</p>
<p class="expiry">Expires in ${expiresIn}</p>
<a class="btn" href="/api/download/${file.token}">
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
Download
</a>
<div class="promo">
<p>Want to share files too?</p>
<a href="/">Start free with 500 MB on Stickr</a>
</div>
</div></body></html>`;
}

function getTimeRemaining(expiresAt) {
  const diff = new Date(expiresAt) - new Date();
  if (diff <= 0) return 'expired';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return hours + 'h ' + minutes + 'm';
  return minutes + 'm';
}

function getBatchDownloadPage(batch, files) {
  const totalSize = files.reduce((sum, f) => sum + f.file_size, 0);
  const expiresIn = getTimeRemaining(batch.expires_at);
  const fileListHtml = files.map(f => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:var(--bg);border:1px solid #2a2a3e;border-radius:10px;">
      <div style="min-width:0;flex:1;">
        <div style="font-size:14px;font-weight:600;color:#e8e8f0;word-break:break-all;">${escapeHtml(f.filename)}</div>
        <div style="font-size:12px;color:#8888a8;margin-top:2px;">${formatBytes(f.file_size)}</div>
      </div>
      <a href="/api/download/${f.token}" style="flex-shrink:0;margin-left:16px;padding:8px 16px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:white;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">Download</a>
    </div>
  `).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stickr — ${files.length} files</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#12121a}
body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:24px}
.card{background:#12121a;border:1px solid #2a2a3e;border-radius:16px;padding:36px;max-width:480px;width:100%}
h1{font-size:22px;margin-bottom:4px;text-align:center}
.meta{color:#8888a8;font-size:13px;text-align:center;margin-bottom:4px}
.expiry{color:#555570;font-size:11px;text-align:center;margin-bottom:20px}
.files{display:flex;flex-direction:column;gap:8px;margin-bottom:20px}
.btn-all{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:white;border:none;cursor:pointer;transition:all 0.2s;margin-bottom:20px}
.btn-all:hover{transform:translateY(-1px);box-shadow:0 4px 20px #6c5ce730}
.logo{font-size:28px;font-weight:800;margin-bottom:24px;text-align:center;background:linear-gradient(135deg,#6c5ce7,#a29bfe);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.promo{border-top:1px solid #2a2a3e;padding-top:20px;text-align:center}
.promo p{color:#8888a8;font-size:13px;margin-bottom:12px}
.promo a{color:#a29bfe;text-decoration:none;font-weight:600;font-size:14px}
.promo a:hover{text-decoration:underline}
</style></head><body>
<div class="card">
<div class="logo">Stickr</div>
<h1>${files.length} file${files.length > 1 ? 's' : ''}</h1>
<p class="meta">${formatBytes(totalSize)} total</p>
<p class="expiry">Expires in ${expiresIn}</p>
<button class="btn-all" onclick="document.querySelectorAll('.dl-link').forEach((a,i)=>setTimeout(()=>a.click(),i*500))">
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
Download All
</button>
<div class="files">${fileListHtml.replace(/href="/g, 'class="dl-link" href="')}</div>
<div class="promo">
<p>Want to share files too?</p>
<a href="/">Start free with 500 MB on Stickr</a>
</div>
</div></body></html>`;
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

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeFilename(name) {
  if (!name) return 'unnamed';
  return name.replace(/\.\./g, '').replace(/[\/\\]/g, '_').replace(/[\x00-\x1f]/g, '').slice(0, 255) || 'unnamed';
}

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

  const wsToken = generateTurnSessionToken();
  turnSessionTokens.set(wsToken, { peerId: ws.id, createdAt: Date.now() });
  ws.turnSessionToken = wsToken;
  ws.send(JSON.stringify({ type: 'session-token', token: wsToken }));

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
