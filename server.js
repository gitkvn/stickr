const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Session tokens - bind TURN creds to active WS sessions
const sessionTokens = new Map();
const SESSION_TOKEN_TTL = 2 * 60 * 60 * 1000;

function generateSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Clean up expired session tokens every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of sessionTokens) {
    if (now - data.createdAt > SESSION_TOKEN_TTL) sessionTokens.delete(token);
  }
}, 10 * 60 * 1000);

// ICE servers endpoint
const iceRateLimit = new Map();
const ICE_RATE_LIMIT = 10;
const ICE_RATE_WINDOW = 60 * 1000;

app.get('/api/ice-servers', async (req, res) => {
  const token = req.query.token;
  if (!token || !sessionTokens.has(token)) {
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

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    rooms: rooms.size,
    uptime: Math.floor(process.uptime()),
  });
});

// Self-ping to prevent Railway cold starts
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

// Room management
const rooms = new Map();

// Clean up any existing room membership before re-create/re-join
function cleanupExistingRoom(ws) {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  if (!room) { ws.roomId = null; ws.role = null; return; }

  if (ws.role === 'host') {
    // Don't delete room immediately — keep it alive for reconnection
    room.host = null;
    for (const [, peer] of room.peers) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({ type: 'host-disconnected' }));
      }
    }
    // Grace period — delete room if host doesn't reconnect
    room.hostGraceTimer = setTimeout(() => {
      const r = rooms.get(ws.roomId);
      if (r && !r.host) {
        // Host never came back — notify peers and delete
        for (const [, peer] of r.peers) {
          if (peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          }
        }
        rooms.delete(ws.roomId);
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

wss.on('connection', (ws) => {
  ws.id = uuidv4();
  ws.isAlive = true;

  const sessionToken = generateSessionToken();
  sessionTokens.set(sessionToken, { peerId: ws.id, createdAt: Date.now() });
  ws.sessionToken = sessionToken;
  ws.send(JSON.stringify({ type: 'session-token', token: sessionToken }));

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        cleanupExistingRoom(ws);
        const roomId = generateRoomId();
        rooms.set(roomId, { host: ws, hostId: ws.id, peers: new Map() });
        ws.roomId = roomId;
        ws.role = 'host';
        ws.send(JSON.stringify({ type: 'room-created', roomId, peerId: ws.id }));
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
          // Host is temporarily offline — peer waits. Host will get peer-joined on rejoin.
          ws.send(JSON.stringify({ type: 'room-joined', roomId: msg.roomId, peerId: ws.id, hostId: room.hostId }));
        }
        break;
      }

      case 'rejoin-host': {
        // Host reconnecting to their room after backgrounding
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        // Cancel the grace timer
        if (room.hostGraceTimer) {
          clearTimeout(room.hostGraceTimer);
          room.hostGraceTimer = null;
        }
        // Reassign host
        room.host = ws;
        room.hostId = ws.id;
        ws.roomId = msg.roomId;
        ws.role = 'host';
        ws.send(JSON.stringify({ type: 'room-joined', roomId: msg.roomId, peerId: ws.id, hostId: ws.id }));
        // Notify existing peers so they can create new peer connections
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
    if (ws.sessionToken) sessionTokens.delete(ws.sessionToken);
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
