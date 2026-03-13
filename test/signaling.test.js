const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const assert = require('assert');

let server, wss, port;
const rooms = new Map();
const turnSessionTokens = new Map();

function generateTurnSessionToken() { return crypto.randomBytes(24).toString('hex'); }

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id;
  do { id = ''; for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)]; } while (rooms.has(id));
  return id;
}

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
      if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'host-disconnected' }));
    }
    room.hostGraceTimer = setTimeout(() => {
      const r = rooms.get(roomId);
      if (r && !r.host) {
        for (const [, peer] of r.peers) {
          if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        }
        rooms.delete(roomId);
      }
    }, 30000);
  } else {
    room.peers.delete(ws.id);
    if (room.host && room.host.readyState === WebSocket.OPEN)
      room.host.send(JSON.stringify({ type: 'peer-disconnected', peerId: ws.id }));
  }
  ws.roomId = null; ws.role = null;
}

function setup() {
  return new Promise((resolve) => {
    const app = express();
    server = http.createServer(app);
    wss = new WebSocket.Server({ server });
    wss.on('connection', (ws) => {
      ws.id = uuidv4(); ws.isAlive = true;
      // NO session-token on connect — matches production behavior
      // Tokens are only issued on create-room, join-room, rejoin-host
      ws.user = { id: 'test-user-' + ws.id, email: 'test@test.com' };
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        switch (msg.type) {
          case 'create-room': {
            if (!ws.user) {
              ws.send(JSON.stringify({ type: 'error', message: 'auth-required' }));
              return;
            }
            cleanupExistingRoom(ws);
            const roomId = generateRoomId();
            rooms.set(roomId, { host: ws, hostId: ws.id, hostUserId: ws.user.id, peers: new Map(), hostGraceTimer: null });
            ws.roomId = roomId; ws.role = 'host';
            const token = generateTurnSessionToken();
            turnSessionTokens.set(token, { peerId: ws.id, createdAt: Date.now() });
            ws.turnSessionToken = token;
            ws.send(JSON.stringify({ type: 'session-token', token }));
            ws.send(JSON.stringify({ type: 'room-created', roomId, peerId: ws.id }));
            break;
          }
          case 'join-room': {
            cleanupExistingRoom(ws);
            const room = rooms.get(msg.roomId);
            if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
            ws.roomId = msg.roomId; ws.role = 'peer';
            room.peers.set(ws.id, ws);
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
            const rRoom = rooms.get(msg.roomId);
            if (!rRoom) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
            if (rRoom.hostUserId !== ws.user.id) {
              ws.send(JSON.stringify({ type: 'error', message: 'Not authorized to rejoin as host' }));
              return;
            }
            if (rRoom.hostGraceTimer) { clearTimeout(rRoom.hostGraceTimer); rRoom.hostGraceTimer = null; }
            rRoom.host = ws;
            rRoom.hostId = ws.id;
            ws.roomId = msg.roomId; ws.role = 'host';
            const rejoinToken = generateTurnSessionToken();
            turnSessionTokens.set(rejoinToken, { peerId: ws.id, createdAt: Date.now() });
            ws.turnSessionToken = rejoinToken;
            ws.send(JSON.stringify({ type: 'session-token', token: rejoinToken }));
            ws.send(JSON.stringify({ type: 'rejoin-confirmed', roomId: msg.roomId, peerId: ws.id }));
            for (const [peerId, peer] of rRoom.peers) {
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
            const target = msg.to === room.hostId ? room.host : room.peers.get(msg.to);
            if (target && target.readyState === WebSocket.OPEN)
              target.send(JSON.stringify({ type: 'signal', from: ws.id, signal: msg.signal }));
            break;
          }
        }
      });
      ws.on('close', () => {
        if (ws.turnSessionToken) turnSessionTokens.delete(ws.turnSessionToken);
        cleanupExistingRoom(ws);
      });
    });
    server.listen(0, () => { port = server.address().port; resolve(); });
  });
}

function teardown() {
  return new Promise((resolve) => {
    rooms.clear(); turnSessionTokens.clear();
    wss.close(() => { server.close(resolve); });
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:' + port);
    const messages = [];
    ws.on('message', (data) => { messages.push(JSON.parse(data.toString())); });
    ws.on('open', () => { setTimeout(() => resolve({ ws, messages }), 50); });
    ws.on('error', reject);
  });
}

function waitFor(client, type, ms) {
  ms = ms || 2000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for ' + type)), ms);
    function check() {
      const found = client.messages.find(function(m) { return m.type === type; });
      if (found) { clearTimeout(timer); resolve(found); } else setTimeout(check, 20);
    }
    check();
  });
}

function send(ws, msg) { ws.send(JSON.stringify(msg)); }

var passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  \x1b[32m+\x1b[0m ' + name); }
  catch (err) { failed++; console.log('  \x1b[31mx\x1b[0m ' + name + '\n    ' + err.message); }
}

async function run() {
  console.log('\nStickr Signaling Tests\n');
  await setup();

  await test('no session token on bare connect', async () => {
    const c = await connect();
    const t = c.messages.find(function(m) { return m.type === 'session-token'; });
    assert(!t, 'Should NOT receive session-token on bare connect');
    c.ws.close();
  });

  await test('session token issued on create-room', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const msg = await waitFor(h, 'room-created');
    assert.strictEqual(msg.roomId.length, 6);
    assert(msg.peerId);
    const t = h.messages.find(function(m) { return m.type === 'session-token'; });
    assert(t, 'Should receive session-token on create-room');
    assert.strictEqual(t.token.length, 48);
    h.ws.close();
  });

  await test('session token issued on join-room', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const created = await waitFor(h, 'room-created');
    const p = await connect();
    send(p.ws, { type: 'join-room', roomId: created.roomId });
    await waitFor(p, 'room-joined');
    const t = p.messages.find(function(m) { return m.type === 'session-token'; });
    assert(t, 'Peer should receive session-token on join');
    h.ws.close(); p.ws.close();
  });

  await test('peer joins existing room, both sides notified', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const created = await waitFor(h, 'room-created');
    const p = await connect();
    send(p.ws, { type: 'join-room', roomId: created.roomId });
    const joined = await waitFor(p, 'room-joined');
    assert.strictEqual(joined.roomId, created.roomId);
    assert(joined.hostId);
    const pj = await waitFor(h, 'peer-joined');
    assert(pj.peerId);
    h.ws.close(); p.ws.close();
  });

  await test('joining non-existent room returns error', async () => {
    const p = await connect();
    send(p.ws, { type: 'join-room', roomId: 'zzzzzz' });
    const err = await waitFor(p, 'error');
    assert.strictEqual(err.message, 'Room not found');
    p.ws.close();
  });

  await test('relays signals between host and peer', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const created = await waitFor(h, 'room-created');
    const p = await connect();
    send(p.ws, { type: 'join-room', roomId: created.roomId });
    const joined = await waitFor(p, 'room-joined');
    send(p.ws, { type: 'signal', to: joined.hostId, signal: { type: 'offer', sdp: 'test-sdp' } });
    const sig = await waitFor(h, 'signal');
    assert.strictEqual(sig.signal.sdp, 'test-sdp');
    assert(sig.from);
    h.messages.length = 0;
    send(h.ws, { type: 'signal', to: joined.peerId, signal: { type: 'answer', sdp: 'reply-sdp' } });
    const sig2 = await waitFor(p, 'signal');
    assert.strictEqual(sig2.signal.sdp, 'reply-sdp');
    h.ws.close(); p.ws.close();
  });

  await test('notifies peers when host disconnects', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const created = await waitFor(h, 'room-created');
    const p = await connect();
    send(p.ws, { type: 'join-room', roomId: created.roomId });
    await waitFor(p, 'room-joined');
    h.ws.close();
    await waitFor(p, 'host-disconnected');
    p.ws.close();
  });

  await test('notifies host when peer disconnects', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const created = await waitFor(h, 'room-created');
    const p = await connect();
    send(p.ws, { type: 'join-room', roomId: created.roomId });
    await waitFor(h, 'peer-joined');
    p.ws.close();
    const disc = await waitFor(h, 'peer-disconnected');
    assert(disc.peerId);
    h.ws.close();
  });

  await test('creating second room cleans up first', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const first = await waitFor(h, 'room-created');
    assert(rooms.has(first.roomId));
    h.messages.length = 0;
    send(h.ws, { type: 'create-room' });
    const second = await waitFor(h, 'room-created');
    assert(rooms.has(second.roomId), 'Second room should exist');
    h.ws.close();
  });

  await test('re-create notifies peers of old room', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const first = await waitFor(h, 'room-created');
    const p = await connect();
    send(p.ws, { type: 'join-room', roomId: first.roomId });
    await waitFor(p, 'room-joined');
    h.messages.length = 0;
    send(h.ws, { type: 'create-room' });
    await waitFor(h, 'room-created');
    const disc = await waitFor(p, 'host-disconnected');
    assert(disc, 'Peer should receive host-disconnected when host re-creates');
    h.ws.close(); p.ws.close();
  });

  await test('joining second room cleans up first membership', async () => {
    const h1 = await connect();
    send(h1.ws, { type: 'create-room' });
    const room1 = await waitFor(h1, 'room-created');
    const h2 = await connect();
    send(h2.ws, { type: 'create-room' });
    const room2 = await waitFor(h2, 'room-created');
    const p = await connect();
    send(p.ws, { type: 'join-room', roomId: room1.roomId });
    await waitFor(p, 'room-joined');
    assert.strictEqual(rooms.get(room1.roomId).peers.size, 1);
    p.messages.length = 0;
    send(p.ws, { type: 'join-room', roomId: room2.roomId });
    await waitFor(p, 'room-joined');
    assert.strictEqual(rooms.get(room1.roomId).peers.size, 0, 'Room1 should have 0 peers');
    const disc = await waitFor(h1, 'peer-disconnected');
    assert(disc.peerId, 'Host1 should receive peer-disconnected');
    h1.ws.close(); h2.ws.close(); p.ws.close();
  });

  await test('TURN token revoked when switching rooms', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    await waitFor(h, 'room-created');
    const t1 = h.messages.find(function(m) { return m.type === 'session-token'; });
    assert(turnSessionTokens.has(t1.token), 'Token should exist after create');
    h.messages.length = 0;
    send(h.ws, { type: 'create-room' });
    await waitFor(h, 'room-created');
    assert(!turnSessionTokens.has(t1.token), 'Old TURN token should be revoked on room switch');
    const t2 = h.messages.find(function(m) { return m.type === 'session-token'; });
    assert(turnSessionTokens.has(t2.token), 'New token should exist');
    h.ws.close();
  });

  await test('TURN token deleted on disconnect', async () => {
    const c = await connect();
    send(c.ws, { type: 'create-room' });
    await waitFor(c, 'room-created');
    const t = c.messages.find(function(m) { return m.type === 'session-token'; });
    assert(turnSessionTokens.has(t.token));
    c.ws.close();
    await new Promise(function(r) { setTimeout(r, 150); });
    assert(!turnSessionTokens.has(t.token), 'Token should be deleted on disconnect');
  });

  await test('signal to non-existent room is silently dropped', async () => {
    const c = await connect();
    send(c.ws, { type: 'signal', to: 'fake-id', signal: { sdp: 'x' } });
    await new Promise(function(r) { setTimeout(r, 100); });
    c.ws.close();
  });

  await teardown();
  console.log('\n  ' + passed + ' passing, ' + failed + ' failing\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(function(err) { console.error(err); process.exit(1); });
