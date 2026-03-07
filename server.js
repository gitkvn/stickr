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

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ═══════════════════════════════════════════
// R2 OBJECT STORAGE
// ═══════════════════════════════════════════
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'stickr-files';
const ASYNC_FILE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const ASYNC_THRESHOLD = 25 * 1024 * 1024; // 25MB

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
const db = new Database(path.join(__dirname, 'stickr.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    picture TEXT,
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
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Prepared statements
const stmts = {
  findUserByGoogleId: db.prepare('SELECT * FROM users WHERE google_id = ?'),
  findUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  createUser: db.prepare('INSERT INTO users (id, google_id, email, name, picture) VALUES (?, ?, ?, ?, ?)'),
  updateUser: db.prepare('UPDATE users SET name = ?, picture = ?, email = ? WHERE google_id = ?'),
  createSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
  findSession: db.prepare(`SELECT s.token as session_token, s.user_id, s.expires_at,
    u.id, u.google_id, u.email, u.name, u.picture, u.transfer_balance, u.created_at
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  cleanExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')"),
  updateBalance: db.prepare('UPDATE users SET transfer_balance = ? WHERE id = ?'),
  createPendingTransfer: db.prepare('INSERT INTO pending_transfers (file_id, user_id, file_size) VALUES (?, ?, ?)'),
  findPendingTransfer: db.prepare('SELECT * FROM pending_transfers WHERE file_id = ? AND user_id = ?'),
  markRefunded: db.prepare('UPDATE pending_transfers SET refunded = 1 WHERE file_id = ? AND user_id = ?'),
  cleanOldTransfers: db.prepare("DELETE FROM pending_transfers WHERE created_at < datetime('now', '-1 day')"),
  // Async file queries
  createAsyncFile: db.prepare('INSERT INTO async_files (token, user_id, filename, file_size, mime_type, r2_key, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  findAsyncFile: db.prepare('SELECT * FROM async_files WHERE token = ?'),
  incrementDownloadCount: db.prepare('UPDATE async_files SET download_count = download_count + 1 WHERE token = ?'),
  findExpiredFiles: db.prepare("SELECT * FROM async_files WHERE expires_at < datetime('now')"),
  deleteAsyncFile: db.prepare('DELETE FROM async_files WHERE token = ?'),
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
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE / 1000,
  }));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE, '', {
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
    transfer_balance: row.transfer_balance,
    created_at: row.created_at,
  };
}

// ═══════════════════════════════════════════
// GOOGLE OAUTH ROUTES
// ═══════════════════════════════════════════
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).send('Google OAuth not configured');
  }
  const redirectUri = `${getBaseUrl(req)}/auth/callback`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

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
    } else {
      const userId = uuidv4();
      stmts.createUser.run(userId, profile.id, profile.email, profile.name, profile.picture || null);
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
    transfer_balance: user.transfer_balance,
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
// TRANSFER TRACKING API
// ═══════════════════════════════════════════
app.use(express.json());

// Start a transfer — deduct bytes upfront
app.post('/api/transfer/start', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { fileSize, fileId } = req.body;
  if (!fileSize || !fileId || typeof fileSize !== 'number' || fileSize <= 0) {
    return res.status(400).json({ error: 'Invalid file size' });
  }
  if (typeof fileId !== 'string' || fileId.length > 100) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  // Check balance
  const currentUser = stmts.findUserById.get(user.id);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  if (currentUser.transfer_balance < fileSize) {
    return res.status(403).json({
      error: 'insufficient_balance',
      balance: currentUser.transfer_balance,
      required: fileSize,
    });
  }

  // Deduct and record pending transfer
  const newBalance = currentUser.transfer_balance - fileSize;
  stmts.updateBalance.run(newBalance, user.id);
  try {
    stmts.createPendingTransfer.run(fileId, user.id, fileSize);
  } catch (e) {
    // Duplicate fileId — ignore, deduction still stands
  }

  res.json({ balance: newBalance });
});

// Refund a failed/cancelled transfer — only refunds what was actually deducted
app.post('/api/transfer/refund', (req, res) => {
  const user = getUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { fileSize, fileId } = req.body;
  if (!fileSize || !fileId || typeof fileSize !== 'number' || fileSize <= 0) {
    return res.status(400).json({ error: 'Invalid file size' });
  }

  // Only refund if there's a matching pending transfer that hasn't been refunded
  const pending = stmts.findPendingTransfer.get(fileId, user.id);
  if (!pending || pending.refunded) {
    return res.status(400).json({ error: 'No refundable transfer found' });
  }

  // Refund at most the original deducted amount
  const refundAmount = Math.min(fileSize, pending.file_size);

  const currentUser = stmts.findUserById.get(user.id);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  const newBalance = currentUser.transfer_balance + refundAmount;
  stmts.updateBalance.run(newBalance, user.id);
  stmts.markRefunded.run(fileId, user.id);

  res.json({ balance: newBalance });
});

// ═══════════════════════════════════════════
// STATIC FILES
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// ASYNC FILE TRANSFER (R2)
// ═══════════════════════════════════════════

// Upload a file to R2 (authenticated, streams to R2)
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB per file

app.post('/api/upload', async (req, res) => {
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

  // Check balance using declared size
  const currentUser = stmts.findUserById.get(user.id);
  if (!currentUser) return res.status(401).json({ error: 'User not found' });

  if (declaredSize && currentUser.transfer_balance < declaredSize) {
    return res.status(403).json({
      error: 'insufficient_balance',
      balance: currentUser.transfer_balance,
      required: declaredSize,
    });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const r2Key = `${user.id}/${token}/${filename}`;
  const expiresAt = new Date(Date.now() + ASYNC_FILE_EXPIRY).toISOString();

  // Track bytes as they stream through
  let bytesReceived = 0;
  const { PassThrough } = require('stream');
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

    // Deduct actual bytes from balance
    if (currentUser.transfer_balance < fileSize) {
      // Edge case: balance dipped between check and completion
      // Still save the file but set balance to 0
      stmts.updateBalance.run(0, user.id);
    } else {
      const newBalance = currentUser.transfer_balance - fileSize;
      stmts.updateBalance.run(newBalance, user.id);
    }

    // Record in database
    stmts.createAsyncFile.run(token, user.id, filename, fileSize, mimeType, r2Key, expiresAt);

    // Track as pending transfer for stats
    const fileId = 'async-' + token;
    try { stmts.createPendingTransfer.run(fileId, user.id, fileSize); } catch {}

    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const downloadUrl = `${protocol}://${host}/dl/${token}`;

    res.json({
      token,
      url: downloadUrl,
      balance: stmts.findUserById.get(user.id).transfer_balance,
      expiresAt,
    });
  } catch (err) {
    console.error('R2 upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Download page (public, branded)
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

    res.set({
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.filename)}"`,
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
<title>Stickr — Download ${file.filename}</title>
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
<h1>${file.filename}</h1>
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

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════
wss.on('connection', (ws, req) => {
  ws.id = uuidv4();
  ws.isAlive = true;

  // Attach user from cookie if authenticated
  ws.user = getUserFromCookie(req);

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Stickr server running on http://localhost:${PORT}`);
  startSelfPing();
});
