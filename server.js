// Transfer Portal signaling server.
// Pairs up to two peers per room code and relays WebRTC handshakes between them.
// File bytes never pass through here — they go directly computer-to-computer.
// It's meant to sit on the public internet (e.g. Render), so it keeps every limit tight: handshakes are a few KB,
// one app opens at most a handful of sockets (one live, one watching each other PC it knows).
// The only thing it keeps is the MAILBOX: locked messages for a PC that's offline, which it can't read (see below).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const mailer = require('./mailer');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || undefined; // e.g. 127.0.0.1 when a tunnel (Tailscale Funnel) is the only way in
const MAX_MESSAGE = 256 * 1024;     // bytes per message (an offer/answer is a few KB)
const MAX_PER_IP = 32;              // open sockets from one address
const MAX_ROOMS = 5000;             // rooms at once
const RATE = { per: 10000, max: 300 }; // messages per socket per 10 s

// ---- Mailbox ----
// Two PCs that pair each make a mailbox for messages FROM the other, and hand the other its random id and a lock key
// over their direct encrypted link - this server never sees the key. When one writes to the other while it's offline,
// the message is locked (AES-256-GCM) on the sender's PC and left here; the owner collects it with its own token (only
// a hash of which is kept) and it's deleted. Anyone who knows a mailbox's id can drop a message in; only the owner can
// read the list or clear it, and even then only as locked data.
const DATA_DIR = process.env.STATE_DIRECTORY || process.env.DATA_DIR || path.join(__dirname, 'data');
const MB = { maxItem: 64 * 1024, maxItems: 200, maxBytes: 5 * 1024 * 1024, ttl: 30 * 86400000, maxBoxes: 20000, maxOpen: 64 };
const BOX_ID = /^[A-Za-z0-9_-]{22,64}$/, ITEM_ID = /^[\w-]{1,40}$/;
const boxes = new Map();      // id -> { tok: sha256 hex | null (owner hasn't claimed it yet), items: [{ id, at, data }] }
const listeners = new Map();  // id -> Set<ws> (the owner's app, while it's online)
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const MB_FILE = path.join(DATA_DIR, 'mailbox.json');
try { for (const [id, b] of Object.entries(JSON.parse(fs.readFileSync(MB_FILE, 'utf8')))) if (BOX_ID.test(id) && b && Array.isArray(b.items)) boxes.set(id, { tok: b.tok || null, items: b.items, notify: b.notify || undefined }); } catch { /* none yet */ }
let saveT = null;
function saveBoxes() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = MB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(boxes)));
      fs.renameSync(tmp, MB_FILE);
    } catch (e) { console.error('mailbox save failed:', e.message); }
  }, 1000);
}
const boxBytes = (b) => b.items.reduce((n, it) => n + it.data.length, 0);
function mbOpen(ws, box, token) {
  if (!BOX_ID.test(box) || typeof token !== 'string' || token.length < 16 || token.length > 128) return false;
  let b = boxes.get(box);
  if (!b) { if (boxes.size >= MB.maxBoxes) return false; b = { tok: null, items: [] }; boxes.set(box, b); }
  if (b.tok && b.tok !== hash(token)) return false;
  if (!b.tok) { b.tok = hash(token); saveBoxes(); }
  if (!listeners.has(box)) listeners.set(box, new Set());
  listeners.get(box).add(ws);
  (ws.boxes = ws.boxes || new Set()).add(box);
  if (b.items.length) send(ws, { type: 'mbox-items', box, items: b.items });
  return true;
}
// ---- Notices for a PC that's offline: a phone ping (ntfy) and/or an email, never the message itself ----
// The owner turns them on from its app (mbox-notify, with its token). A notice goes out when something lands in its
// mailbox while it's offline: a phone ping at most once a minute, an email at most once an hour (a summary).
// ntfy runs on this same machine for phone pings; its address for phones (NTFY_PUBLIC) is passed to the apps so they can
// show it. Emails go out from this server itself (mailer.js), so they look like a proper Transfer Portal email.
const NTFY = { url: (process.env.NTFY_URL || '').replace(/\/+$/, ''), token: process.env.NTFY_TOKEN || '', pub: process.env.NTFY_PUBLIC || '', email: mailer.enabled() };
const noticesOn = () => !!(NTFY.url || NTFY.email);
const TOPIC = /^[A-Za-z0-9_-]{20,64}$/, EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[A-Za-z]{2,24}$/;
const PUSH_GAP = 60000, MAIL_GAP = 3600000;
const nstate = new Map(); // box -> { lastPush, lastMail, n, from: Set, files, timer }
function describe(st) {
  const who = [...st.from].slice(0, 3).join(', ') || 'Someone';
  const chats = st.n - st.files;
  if (st.files && !chats) return { title: `${who} has files for you`, body: 'Open Transfer Portal - they come through when you\'re both online.' };
  if (chats === 1 && !st.files) return { title: `New message from ${who}`, body: 'Open Transfer Portal to read it.' };
  return { title: `${st.n} new in Transfer Portal`, body: `From ${who}. Open Transfer Portal to see ${st.files ? 'them' : 'your messages'}.` };
}
function describeMail(st) {
  const who = [...st.from].slice(0, 3).join(', ') || 'A linked PC';
  const chats = st.n - st.files;
  const open = 'Open Transfer Portal on your PC to see it. It waits there, locked so only your PC can open it.';
  if (st.files && !chats) return { subject: `${who} wants to send you files`, heading: `${who} wants to send you files`, kind: 'files', lines: [`${who} tried to send you files while your PC was away.`, "Open Transfer Portal on your PC. The files come through once you're both online."] };
  if (chats === 1 && !st.files) return { subject: `New message from ${who}`, heading: `You have a new message from ${who}`, kind: 'chat', lines: [`${who} sent you a message while your PC was away.`, open] };
  const what = st.files ? `${chats} message${chats === 1 ? '' : 's'} and ${st.files} file transfer${st.files === 1 ? '' : 's'}` : `${st.n} messages`;
  return { subject: st.files ? `${st.n} new in Transfer Portal from ${who}` : `${st.n} new messages from ${who}`, heading: `You have ${what} waiting`, kind: st.files ? 'files' : 'chat', lines: [`From ${who}, while your PC was away.`, 'Open Transfer Portal on your PC to see them. They wait there, locked so only your PC can open them.'] };
}
async function sendNotice(box) {
  const b = boxes.get(box), st = nstate.get(box);
  if (!b || !b.notify || !st || !st.n || !noticesOn()) return;
  if ((listeners.get(box) || new Set()).size) { st.n = 0; st.files = 0; st.from.clear(); return; } // came back online meanwhile
  const now = Date.now(), d = describe(st);
  const mail = NTFY.email && b.notify.email && now - (st.lastMail || 0) >= MAIL_GAP;
  const push = NTFY.url && b.notify.topic && now - (st.lastPush || 0) >= PUSH_GAP;
  if (!mail && !push) return;
  if (push) {
    const headers = { Title: d.title, Tags: st.files ? 'package' : 'incoming_envelope' };
    if (NTFY.token) headers.Authorization = `Bearer ${NTFY.token}`;
    try {
      const r = await fetch(`${NTFY.url}/${b.notify.topic}`, { method: 'POST', headers, body: d.body });
      if (!r.ok) console.error('phone notice failed:', r.status, await r.text().catch(() => ''));
    } catch (e) { console.error('phone notice failed:', e.message); }
  }
  if (mail) {
    const m = describeMail(st);
    try { await mailer.sendMail(b.notify.email, m.subject, m); } catch (e) { console.error('email notice failed:', e.message || e.code || e); }
  }
  if (push) st.lastPush = now;
  if (mail) st.lastMail = now;
  st.n = 0; st.files = 0; st.from.clear();
}
function queueNotice(box, kind, from) {
  const b = boxes.get(box);
  if (!b || !b.notify || !noticesOn() || kind === 'ack') return;
  if ((listeners.get(box) || new Set()).size) return; // it's online: the item was handed straight over
  const st = nstate.get(box) || { lastPush: 0, lastMail: 0, n: 0, files: 0, from: new Set(), timer: null };
  nstate.set(box, st);
  st.n++; if (kind === 'files') st.files++;
  if (from) st.from.add(String(from).slice(0, 40));
  if (st.timer) return;
  // a moment's pause gathers a burst of messages into one notice; then no more often than a ping a minute
  const wait = Math.max(5000, PUSH_GAP - (Date.now() - st.lastPush));
  st.timer = setTimeout(() => { st.timer = null; sendNotice(box); }, b.notify.topic ? wait : 5000);
}

// old messages nobody collected go after 30 days; a mailbox nobody uses goes when it's empty and unclaimed
setInterval(() => {
  const cut = Date.now() - MB.ttl; let changed = false;
  for (const [id, b] of boxes) {
    const n = b.items.length; b.items = b.items.filter((it) => it.at > cut); if (b.items.length !== n) changed = true;
    if (!b.items.length && !b.tok) { boxes.delete(id); changed = true; }
  }
  if (changed) saveBoxes();
}, 3600000);

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

    // ---- Mailbox ----
    if (msg.type === 'mbox-open') {
      const list = Array.isArray(msg.boxes) ? msg.boxes.slice(0, MB.maxOpen) : [];
      const ok = list.filter((x) => x && mbOpen(ws, String(x.box || ''), x.token)).length;
      return send(ws, { type: 'mbox-open-ok', ok, denied: list.length - ok, notify: noticesOn() ? { phone: (NTFY.url && NTFY.pub) || null, email: NTFY.email } : null });
    }
    // the owner's notice settings for its mailboxes: a phone topic and/or an email address ('' turns one off)
    if (msg.type === 'mbox-notify') {
      const list = Array.isArray(msg.boxes) ? msg.boxes.slice(0, MB.maxOpen) : [];
      const topic = typeof msg.topic === 'string' && TOPIC.test(msg.topic) ? msg.topic : null;
      const email = typeof msg.email === 'string' && EMAIL.test(msg.email.trim()) ? msg.email.trim().slice(0, 254) : null;
      let ok = 0;
      for (const x of list) {
        const b = x && boxes.get(String(x.box || ''));
        if (!b || !b.tok || b.tok !== hash(x.token)) continue;
        b.notify = topic || email ? { topic, email } : undefined;
        ok++;
      }
      saveBoxes();
      return send(ws, { type: 'mbox-notify-ok', ok, topic: !!topic, email: !!email });
    }
    if (msg.type === 'mbox-put') {
      const box = String(msg.box || ''), id = String(msg.id || ''), data = msg.data;
      if (!BOX_ID.test(box) || !ITEM_ID.test(id) || typeof data !== 'string' || !data.length || data.length > MB.maxItem) return send(ws, { type: 'mbox-error', id, message: 'Bad message' });
      let b = boxes.get(box);
      if (!b) { if (boxes.size >= MB.maxBoxes) return send(ws, { type: 'mbox-error', id, message: 'Mailbox server is full' }); b = { tok: null, items: [] }; boxes.set(box, b); }
      if (!b.items.some((it) => it.id === id)) {
        if (b.items.length >= MB.maxItems || boxBytes(b) + data.length > MB.maxBytes) return send(ws, { type: 'mbox-error', id, message: 'That mailbox is full' });
        const item = { id, at: Date.now(), data };
        b.items.push(item); saveBoxes();
        for (const l of listeners.get(box) || []) send(l, { type: 'mbox-items', box, items: [item] });
        queueNotice(box, String(msg.kind || 'chat'), msg.from);
      }
      return send(ws, { type: 'mbox-ok', box, id, online: (listeners.get(box) || new Set()).size > 0 });
    }
    if (msg.type === 'mbox-ack') {
      const box = String(msg.box || ''), b = boxes.get(box);
      if (!b || !b.tok || b.tok !== hash(msg.token) || !Array.isArray(msg.ids)) return;
      const ids = new Set(msg.ids.map(String)); const n = b.items.length;
      b.items = b.items.filter((it) => !ids.has(it.id));
      if (b.items.length !== n) saveBoxes();
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
    for (const box of ws.boxes || []) { const l = listeners.get(box); if (l) { l.delete(ws); if (!l.size) listeners.delete(box); } }
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

server.listen(PORT, HOST, () => console.log(`Transfer Portal signaling listening on ${HOST || '*'}:${PORT}`));
