// Transfer Portal signaling server.
// Pairs up to two peers per room code and relays WebRTC handshakes between them.
// File bytes never pass through here — they go directly computer-to-computer.
// It's meant to sit on the public internet (e.g. Render), so it keeps every limit tight: handshakes are a few KB,
// one app opens at most a handful of sockets (one live, one watching each other PC it knows), and nothing is stored.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const MAX_MESSAGE = 256 * 1024;     // bytes per message (an offer/answer is a few KB)
const MAX_PER_IP = 32;              // open sockets from one address
const MAX_ROOMS = 5000;             // rooms at once
const RATE = { per: 10000, max: 300 }; // messages per socket per 10 s

const server = http.createServer((req, res) => {
  // A plain status page: hosts use it as a health check, and it wakes a sleeping free-tier server.
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end('Transfer Portal signaling OK\n');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE });
wss.on('error', (e) => console.error('websocket server error:', e.message));
server.on('clientError', (e, socket) => { try { socket.destroy(); } catch { /* gone */ } });
const rooms = new Map(); // code -> Set<ws>
const perIp = new Map(); // address -> open sockets

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function others(ws) {
  const room = rooms.get(ws.room);
  return room ? [...room].filter(p => p !== ws) : [];
}

function leave(ws) {
  const room = rooms.get(ws.room);
  if (!room) return;
  room.delete(ws);
  for (const p of room) send(p, { type: 'peer-left', name: ws.name });
  if (room.size === 0) rooms.delete(ws.room);
  ws.room = null;
}

// The caller's address; behind a host's proxy (Render) it's the first address in X-Forwarded-For.
function addressOf(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}

wss.on('connection', (ws, req) => {
  const ip = addressOf(req);
  const open = (perIp.get(ip) || 0) + 1;
  if (open > MAX_PER_IP) { ws.close(1008, 'Too many connections'); return; }
  perIp.set(ip, open);
  ws.ip = ip;
  ws.alive = true;
  ws.budget = { start: Date.now(), count: 0 };
  ws.on('pong', () => { ws.alive = true; });
  // a bad frame (too big, malformed) closes that socket; without this handler it would crash the whole server
  ws.on('error', () => { try { ws.terminate(); } catch { /* already gone */ } });

  ws.on('message', raw => {
    // too many messages in a short time: this isn't an app doing a handshake
    const b = ws.budget;
    if (Date.now() - b.start > RATE.per) { b.start = Date.now(); b.count = 0; }
    if (++b.count > RATE.max) { ws.close(1008, 'Slow down'); return; }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      const code = String(msg.room || '').trim().toLowerCase().slice(0, 64);
      if (!code) return send(ws, { type: 'error', message: 'Missing pair code' });
      if (ws.room) leave(ws);
      if (!rooms.has(code) && rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: 'The server is busy, try again in a minute' });
      const room = rooms.get(code) || new Set();
      // Same app reconnecting after a network blip: replace its stale socket.
      for (const p of room) if (msg.clientId && p.clientId === msg.clientId) { room.delete(p); p.room = null; p.terminate(); }
      if (room.size >= 2) return send(ws, { type: 'error', message: 'That pair code already has two people connected' });
      ws.room = code;
      ws.name = String(msg.name || 'Someone').slice(0, 40);
      ws.clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : undefined;
      // A passive socket only watches presence (that PC's app is paired on another code). It never starts a
      // WebRTC connection and is never offered one.
      ws.passive = !!msg.passive;
      room.add(ws);
      rooms.set(code, room);
      const peers = others(ws);
      const live = peers.filter(p => !p.passive);
      // The newcomer makes the WebRTC offer; whoever was waiting answers.
      send(ws, { type: 'joined', peer: peers[0]?.name || null, peerPassive: peers.length > 0 && live.length === 0, initiator: !ws.passive && live.length > 0 });
      for (const p of peers) send(p, { type: 'peer-joined', name: ws.name, peerPassive: ws.passive });
      return;
    }

    // Handshakes, plus the "please pair with me" nudge a sending app gives a PC that's only watching this code.
    // A watching (passive) socket never sends signals itself.
    if (msg.type === 'signal' && ws.room && !ws.passive) {
      for (const p of others(ws)) send(p, { type: 'signal', data: msg.data });
    }
  });

  ws.on('close', () => {
    leave(ws);
    const n = (perIp.get(ws.ip) || 1) - 1;
    if (n > 0) perIp.set(ws.ip, n); else perIp.delete(ws.ip);
  });
});

// Drop dead sockets and keep free-tier hosts from idling the connection.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`Transfer Portal signaling listening on :${PORT}`));
