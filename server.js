const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ICE servers endpoint — generates ephemeral TURN credentials from Cloudflare
app.get('/api/ice-servers', async (req, res) => {
  const TURN_KEY_ID = process.env.TURN_KEY_ID;
  const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN;

  if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) {
    // Fallback to STUN-only if TURN credentials aren't configured
    console.warn('TURN credentials not configured — returning STUN-only');
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
        body: JSON.stringify({ ttl: 86400 }), // 24 hour expiry
      }
    );

    if (!response.ok) {
      throw new Error(`Cloudflare API returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Failed to fetch TURN credentials:', err.message);
    // Fallback to STUN-only
    res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    });
  }
});

// Health check endpoint — keeps Railway from sleeping
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    rooms: rooms.size,
    uptime: Math.floor(process.uptime()),
  });
});

// Self-ping every 4 minutes to prevent Railway cold starts
const SELF_PING_INTERVAL = 4 * 60 * 1000;
let selfPingTimer = null;

function startSelfPing() {
  const appUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
    : null;

  if (!appUrl) {
    console.log('No RAILWAY_PUBLIC_DOMAIN set — skipping self-ping');
    return;
  }

  selfPingTimer = setInterval(async () => {
    try {
      await fetch(appUrl);
    } catch (e) {
      // silent fail — server will just cold start if ping fails
    }
  }, SELF_PING_INTERVAL);

  console.log(`Self-ping active: ${appUrl} every ${SELF_PING_INTERVAL / 1000}s`);
}

// Room management
const rooms = new Map(); // roomId -> { host: ws, peers: Map<peerId, ws> }

wss.on('connection', (ws) => {
  ws.id = uuidv4();
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        const roomId = generateRoomId();
        rooms.set(roomId, { host: ws, hostId: ws.id, peers: new Map() });
        ws.roomId = roomId;
        ws.role = 'host';
        ws.send(JSON.stringify({ type: 'room-created', roomId, peerId: ws.id }));
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        if (!room.host || room.host.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Host is offline' }));
          return;
        }
        ws.roomId = msg.roomId;
        ws.role = 'peer';
        room.peers.set(ws.id, ws);

        // Notify the peer they joined
        ws.send(JSON.stringify({ type: 'room-joined', roomId: msg.roomId, peerId: ws.id, hostId: room.hostId }));

        // Notify host about new peer
        room.host.send(JSON.stringify({ type: 'peer-joined', peerId: ws.id }));
        break;
      }

      case 'signal': {
        // Relay WebRTC signaling messages
        const room = rooms.get(ws.roomId);
        if (!room) return;

        const target = msg.to === room.hostId
          ? room.host
          : room.peers.get(msg.to);

        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({
            type: 'signal',
            from: ws.id,
            signal: msg.signal
          }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    if (ws.role === 'host') {
      // Notify all peers that host disconnected
      for (const [, peer] of room.peers) {
        if (peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ type: 'host-disconnected' }));
        }
      }
      rooms.delete(ws.roomId);
    } else {
      room.peers.delete(ws.id);
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({ type: 'peer-disconnected', peerId: ws.id }));
      }
    }
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
