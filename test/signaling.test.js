const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const assert = require('assert');

let server, wss, port;
const rooms = new Map();
const sessionTokens = new Map();

function generateSessionToken() { return crypto.randomBytes(24).toString('hex'); }

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id;
  do { id = ''; for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)]; } while (rooms.has(id));
  return id;
}

function cleanupExistingRoom(ws) {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  if (!room) { ws.roomId = null; ws.role = null; return; }
  if (ws.role === 'host') {
    for (const [, peer] of room.peers) {
      if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'host-disconnected' }));
    }
    rooms.delete(ws.roomId);
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
      const token = generateSessionToken();
      sessionTokens.set(token, { peerId: ws.id, createdAt: Date.now() });
      ws.sessionToken = token;
      ws.send(JSON.stringify({ type: 'session-token', token }));
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        switch (msg.type) {
          case 'create-room': {
            cleanupExistingRoom(ws);
            const roomId = generateRoomId();
            rooms.set(roomId, { host: ws, hostId: ws.id, peers: new Map() });
            ws.roomId = roomId; ws.role = 'host';
            ws.send(JSON.stringify({ type: 'room-created', roomId, peerId: ws.id }));
            break;
          }
          case 'join-room': {
            cleanupExistingRoom(ws);
            const room = rooms.get(msg.roomId);
            if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
            if (!room.host || room.host.readyState !== WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'error', message: 'Host is offline' })); return; }
            ws.roomId = msg.roomId; ws.role = 'peer';
            room.peers.set(ws.id, ws);
            ws.send(JSON.stringify({ type: 'room-joined', roomId: msg.roomId, peerId: ws.id, hostId: room.hostId }));
            room.host.send(JSON.stringify({ type: 'peer-joined', peerId: ws.id }));
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
        if (ws.sessionToken) sessionTokens.delete(ws.sessionToken);
        cleanupExistingRoom(ws);
      });
    });
    server.listen(0, () => { port = server.address().port; resolve(); });
  });
}

function teardown() {
  return new Promise((resolve) => {
    rooms.clear(); sessionTokens.clear();
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

  await test('sends session token on connect', async () => {
    const c = await connect();
    const t = c.messages.find(function(m) { return m.type === 'session-token'; });
    assert(t, 'No session-token received');
    assert.strictEqual(t.token.length, 48, 'Token should be 48 hex chars');
    c.ws.close();
  });

  await test('creates a room with 6-char ID', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const msg = await waitFor(h, 'room-created');
    assert.strictEqual(msg.roomId.length, 6);
    assert(msg.peerId);
    h.ws.close();
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
    // Also test host -> peer direction
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

  await test('room deleted when host disconnects', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const created = await waitFor(h, 'room-created');
    assert(rooms.has(created.roomId));
    h.ws.close();
    await new Promise(function(r) { setTimeout(r, 150); });
    assert(!rooms.has(created.roomId), 'Room should be deleted');
  });

  await test('creating second room cleans up first (repeated create fix)', async () => {
    const h = await connect();
    send(h.ws, { type: 'create-room' });
    const first = await waitFor(h, 'room-created');
    assert(rooms.has(first.roomId));
    h.messages.length = 0;
    send(h.ws, { type: 'create-room' });
    const second = await waitFor(h, 'room-created');
    assert(!rooms.has(first.roomId), 'First room should be cleaned up');
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
    // Host creates a new room - peer should get host-disconnected
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
    // Now join room2 - should auto-leave room1
    p.messages.length = 0;
    send(p.ws, { type: 'join-room', roomId: room2.roomId });
    await waitFor(p, 'room-joined');
    assert.strictEqual(rooms.get(room1.roomId).peers.size, 0, 'Room1 should have 0 peers');
    const disc = await waitFor(h1, 'peer-disconnected');
    assert(disc.peerId, 'Host1 should receive peer-disconnected');
    h1.ws.close(); h2.ws.close(); p.ws.close();
  });

  await test('session token deleted on disconnect', async () => {
    const c = await connect();
    const t = c.messages.find(function(m) { return m.type === 'session-token'; });
    assert(sessionTokens.has(t.token));
    c.ws.close();
    await new Promise(function(r) { setTimeout(r, 150); });
    assert(!sessionTokens.has(t.token), 'Token should be deleted');
  });

  await test('signal to non-existent room is silently dropped', async () => {
    const c = await connect();
    // Send signal without being in a room - should not crash
    send(c.ws, { type: 'signal', to: 'fake-id', signal: { sdp: 'x' } });
    await new Promise(function(r) { setTimeout(r, 100); });
    // If we get here without error, the server handled it gracefully
    c.ws.close();
  });

  await teardown();
  console.log('\n  ' + passed + ' passing, ' + failed + ' failing\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(function(err) { console.error(err); process.exit(1); });
