# Stickr — P2P File Sharing & Chat

A peer-to-peer file sharing and real-time chat application built with **WebRTC** and **WebSockets**. Files transfer directly between browsers — nothing is ever uploaded to a server.

## Features

- **P2P File Transfer** — Send files of any size directly between devices via WebRTC data channels
- **P2P Chat** — Real-time encrypted messaging alongside file transfers
- **No File Size Limits** — Since nothing is stored on the server, there are no caps
- **End-to-End Encrypted** — WebRTC uses DTLS encryption for all data channels
- **Link Sharing** — Share a simple link or 6-character room code to connect
- **Auto-Join** — Recipients can join directly via shared URL with room hash
- **Drag & Drop** — Drop files onto the interface to send instantly

## How It Works

1. **Sender** clicks "Share Files" → a room is created with a unique 6-character code
2. **Receiver** joins via the link or enters the room code
3. WebRTC establishes a direct peer-to-peer connection (signaling via WebSocket)
4. Files and chat messages flow directly between browsers — the server only facilitates the initial handshake

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (no frameworks)
- **Signaling Server**: Node.js + Express + `ws` (WebSocket)
- **P2P**: WebRTC Data Channels (file transfer + chat on separate channels)
- **Encryption**: DTLS 1.3 (built into WebRTC)

## Setup

```bash
# Install dependencies
npm install

# Start the server
node server.js
```

The app will be available at `http://localhost:3000`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port |

## Architecture

```
Browser A (Sender)                    Browser B (Receiver)
     │                                       │
     │◄──── WebSocket Signaling ────────────►│
     │       (via Node.js server)            │
     │                                       │
     │◄════ WebRTC Data Channel ════════════►│
     │       (direct P2P connection)         │
     │                                       │
     ├── file-transfer channel               │
     └── chat channel                        │
```

The Node.js server only handles:
- Room creation and management
- WebRTC signaling (SDP offers/answers, ICE candidates)

All file data and chat messages go **directly** between peers.
