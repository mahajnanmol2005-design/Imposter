"use strict";
/*
 * Odd Word Out server.
 * Serves the phone app from ./public and runs every game room over one WebSocket (/ws).
 * Secret words and roles stay on the server: each phone is only ever sent its own word,
 * and nobody learns who the odd ones are until the result screen.
 * Rooms live in memory. If the server restarts, running games end.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const WORDS = require("./words.json");
const PAIRS = WORDS.pairs;
const CAT_IDS = new Set(["mixed", ...Object.keys(PAIRS)]);
<<<<<<< HEAD
// Words are pooled per pack. Every round forms a brand new random pair from one pack,
// so nobody can memorise "word A goes with word B", and words do not repeat within a game.
const POOLS = {};
for (const [cat, prs] of Object.entries(PAIRS)) POOLS[cat] = [...new Set(prs.flat())];
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 4;
const MAX_ROOMS = 1000;
<<<<<<< HEAD
const CHAT_KEEP = 80;
// Optional TURN relay for voice on strict mobile networks. Set TURN_URLS (comma separated), TURN_USER, TURN_PASS.
const ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
if (process.env.TURN_URLS) {
  ICE.push({
    urls: process.env.TURN_URLS.split(",").map((x) => x.trim()).filter(Boolean),
    username: process.env.TURN_USER || "",
    credential: process.env.TURN_PASS || "",
  });
}
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
const ROOM_IDLE_MS = 30 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/* ---------------- static files ---------------- */
const server = http.createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
<<<<<<< HEAD
  if (p === "/ice") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ ice: ICE }));
    return;
  }
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
  if (p === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const revalidate = p === "/sw.js" || p === "/index.html" || p === "/app.js" || p === "/style.css";
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": revalidate ? "no-cache" : "public, max-age=3600",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(data);
  });
});

/* ---------------- helpers ---------------- */
const rooms = new Map();
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

function newCode() {
  for (let i = 0; i < 60; i++) {
    let c = "";
    for (let j = 0; j < 4; j++) c += LETTERS[crypto.randomInt(LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const newToken = () => crypto.randomBytes(16).toString("hex");
function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
function cleanName(s) {
  const t = String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
  return t || "Player";
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function makeRoom(code) {
  return {
    code,
    hostId: null,
    players: new Map(),
    seq: 0,
    cfg: { cats: ["mixed"], imps: 2, rounds: 2, mode: "f2f" },
    used: new Set(),
    phase: "lobby",
    rd: 0,
    mode: "f2f",
    rounds: 2,
    k: 1,
    civ: "",
    imp: "",
    roundIds: [],
    impSet: new Set(),
    order: [],
    turn: 0,
    clues: [],
    votes: new Map(),
    seen: new Set(),
    result: null,
    emptySince: null,
<<<<<<< HEAD
    voice: new Map(),
    vseq: 0,
    chat: [],
    cseq: 0,
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
  };
}

function addPlayer(room, name, ws) {
  let base = cleanName(name);
  let nm = base;
  let n = 2;
  const taken = () => [...room.players.values()].some((q) => q.name.toLowerCase() === nm.toLowerCase());
  while (taken()) nm = base.slice(0, 13) + " " + n++;
<<<<<<< HEAD
  const p = { id: "p" + ++room.seq, token: newToken(), name: nm, ws, score: 0, lastChat: 0 };
=======
  const p = { id: "p" + ++room.seq, token: newToken(), name: nm, ws, score: 0 };
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
  room.players.set(p.id, p);
  return p;
}

const connected = (room) => [...room.players.values()].filter((q) => q.ws);

function promoteHost(room) {
  const cur = room.players.get(room.hostId);
  if (cur && cur.ws) return;
  const next = connected(room)[0];
  if (next) room.hostId = next.id;
}

function addScore(room, ids, n) {
  for (const id of ids) {
    const p = room.players.get(id);
    if (p) p.score += n;
  }
}

/* ---------------- what each phone is allowed to see ---------------- */
function view(room, p) {
  const live = room.phase !== "lobby";
  const inRound = live && room.roundIds.includes(p.id);
  const v = {
    t: "state",
    code: room.code,
    me: p.id,
    hostId: room.hostId,
    host: room.hostId === p.id,
    phase: room.phase,
    rd: room.rd,
    cfg: room.cfg,
    players: [...room.players.values()].map((q) => ({
      id: q.id,
      name: q.name,
      on: !!q.ws,
      score: q.score,
      inRound: live && room.roundIds.includes(q.id),
<<<<<<< HEAD
      v: room.voice.get(q.id) || 0,
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
    })),
  };
  if (v.host) v.cats = WORDS.cats;
  if (live) {
    v.k = room.k;
    v.rounds = room.rounds;
    v.mode = room.mode;
    v.order = room.order;
    v.turn = room.turn;
    v.clues = room.clues;
    v.seen = [...room.seen];
    v.voted = [...room.votes.keys()];
    v.myVotes = room.votes.get(p.id) || [];
    if (inRound && room.phase !== "result") v.word = room.impSet.has(p.id) ? room.imp : room.civ;
    if (room.phase === "result") {
      const r = room.result;
      v.result = { oc: r.oc, imps: [...room.impSet], acc: r.acc, tally: r.tally };
      // The words stay hidden while a caught odd one is still trying to guess the group's word.
      if (r.oc !== "ask") {
        v.result.civ = room.civ;
        v.result.imp = room.imp;
      }
    }
  }
  return v;
}

function push(room) {
  for (const p of room.players.values()) if (p.ws) send(p.ws, view(room, p));
}

/* ---------------- game flow ---------------- */
<<<<<<< HEAD
function pickPair(room, cats) {
  const sel = cats.includes("mixed") ? Object.keys(POOLS) : cats.filter((c) => POOLS[c]);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 300; i++) {
      const pool = POOLS[sel[crypto.randomInt(sel.length)]];
      if (pool.length < 2) continue;
      const ia = crypto.randomInt(pool.length);
      // The partner comes from the words listed near it, so the two stay close in meaning
      // while still giving a different combination every game.
      const ib = (ia + (1 + crypto.randomInt(Math.min(6, pool.length - 1))) * (crypto.randomInt(2) ? 1 : -1) + pool.length * 2) % pool.length;
      const a = pool[ia];
      const b = pool[ib];
      if (a === b || room.used.has(a) || room.used.has(b)) continue;
      room.used.add(a);
      room.used.add(b);
      return [a, b];
    }
    room.used.clear(); // every word in these packs has been used: start over
  }
  const pool = POOLS[sel[0]];
  return [pool[0], pool[1]];
}

=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
function deal(room) {
  const ps = connected(room);
  if (ps.length < MIN_PLAYERS) return false;
  const cats = room.cfg.cats;
<<<<<<< HEAD
  const pair = pickPair(room, cats);
  const flip = false;
=======
  const pool = cats.includes("mixed") ? Object.values(PAIRS).flat() : cats.flatMap((c) => PAIRS[c] || []);
  let avail = pool.filter((x) => !room.used.has(x.join("|")));
  if (!avail.length) {
    room.used.clear();
    avail = pool;
  }
  const pair = avail[crypto.randomInt(avail.length)];
  room.used.add(pair.join("|"));
  const flip = crypto.randomInt(2) === 1;
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
  const ids = ps.map((q) => q.id);
  room.rd += 1;
  room.mode = room.cfg.mode;
  room.rounds = room.cfg.rounds;
  room.roundIds = ids;
  room.k = Math.min(room.cfg.imps, Math.floor((ids.length - 1) / 2));
  room.civ = pair[flip ? 1 : 0];
  room.imp = pair[flip ? 0 : 1];
  room.impSet = new Set(shuffle(ids).slice(0, room.k));
  room.order = shuffle(ids);
  room.turn = 0;
  room.clues = [];
  room.votes = new Map();
  room.seen = new Set();
  room.result = null;
  room.phase = "deal";
  return true;
}

const speakerId = (room) => room.order[room.turn % room.order.length];

function advance(room) {
  room.turn += 1;
  if (room.turn >= room.order.length * room.rounds) room.phase = "vote";
}

function reveal(room) {
  if (room.phase !== "vote") return;
  const tally = {};
  room.roundIds.forEach((id) => (tally[id] = 0));
  for (const picks of room.votes.values()) picks.forEach((id) => id in tally && tally[id]++);
  // Shuffle first so ties are broken at random.
  const acc = shuffle(room.roundIds).sort((a, b) => tally[b] - tally[a]).slice(0, room.k);
  const caught = [...room.impSet].every((id) => acc.includes(id));
  room.result = { oc: caught ? "ask" : "survive", acc, tally };
  if (!caught) addScore(room, [...room.impSet], 3);
  room.phase = "result";
}

function checkVotes(room) {
  if (room.phase !== "vote") return;
  const need = room.roundIds.filter((id) => {
    const q = room.players.get(id);
    return q && q.ws;
  });
  if (need.length && need.every((id) => room.votes.has(id))) reveal(room);
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  room.players.delete(id);
<<<<<<< HEAD
  room.voice.delete(id);
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
  if (p.ws) {
    p.ws.ctx = null;
    try {
      p.ws.close();
    } catch {}
  }
  if (!room.players.size) {
    rooms.delete(room.code);
    return;
  }
  promoteHost(room);
  checkVotes(room);
}

function validCfg(m) {
  if (!Array.isArray(m.cats) || m.cats.length < 1 || m.cats.length > 40) return null;
  let cats = [...new Set(m.cats.filter((c) => typeof c === "string" && CAT_IDS.has(c)))];
  if (!cats.length) return null;
  if (cats.includes("mixed")) cats = ["mixed"];
  const imps = m.imps === 2 ? 2 : 1;
  const rounds = [1, 2, 3].includes(m.rounds) ? m.rounds : 2;
  const mode = m.mode === "online" ? "online" : "f2f";
  return { cats, imps, rounds, mode };
}

/* ---------------- messages from phones ---------------- */
function err(ws, msg, fatal) {
  send(ws, { t: "err", msg, fatal: !!fatal });
}

function handle(ws, m) {
  if (m.t === "create") {
    if (ws.ctx) return;
    if (rooms.size >= MAX_ROOMS) return err(ws, "The server is busy. Try again in a few minutes.");
    const code = newCode();
    if (!code) return err(ws, "Could not make a game code. Try again.");
    const room = makeRoom(code);
    rooms.set(code, room);
    const p = addPlayer(room, m.name, ws);
    room.hostId = p.id;
    ws.ctx = { room, id: p.id };
    send(ws, { t: "joined", code, token: p.token });
    push(room);
    return;
  }

  if (m.t === "join") {
    const code = String(m.code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    const room = rooms.get(code);
    if (!room) return err(ws, "No game with that code. Check it and try again.", true);
    let p = null;
    if (typeof m.token === "string" && m.token) {
      for (const q of room.players.values()) {
        if (q.token === m.token) {
          p = q;
          break;
        }
      }
    }
    if (p) {
      if (p.ws && p.ws !== ws) {
        p.ws.ctx = null;
        try {
          p.ws.close();
        } catch {}
      }
      p.ws = ws;
<<<<<<< HEAD
      room.voice.delete(p.id); // a returning phone must rejoin voice, its old connections are gone
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
    } else {
      if (ws.ctx) return;
      if (room.players.size >= MAX_PLAYERS) return err(ws, "That game is full.", true);
      p = addPlayer(room, m.name, ws);
    }
    ws.ctx = { room, id: p.id };
    room.emptySince = null;
    const host = room.players.get(room.hostId);
    if (!host || !host.ws) room.hostId = p.id;
    send(ws, { t: "joined", code, token: p.token });
<<<<<<< HEAD
    send(ws, { t: "chatlog", log: room.chat });
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
    push(room);
    return;
  }

  const c = ws.ctx;
  if (!c) return;
  const room = c.room;
  const p = room.players.get(c.id);
  if (!p) return;
  const host = room.hostId === p.id;
  const inRound = room.roundIds.includes(p.id);

<<<<<<< HEAD
  if (m.t === "rtc") {
    // Voice setup messages are passed between two phones. The server never sees audio.
    const to = typeof m.to === "string" ? room.players.get(m.to) : null;
    if (!to || !to.ws || !m.d || typeof m.d !== "object") return;
    if (!room.voice.has(p.id) || !room.voice.has(to.id)) return;
    send(to.ws, { t: "rtc", from: p.id, d: m.d });
    return;
  }
  if (m.t === "chat") {
    const now = Date.now();
    if (now - p.lastChat < 600) return;
    const text = String(m.text == null ? "" : m.text).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!text) return;
    p.lastChat = now;
    const msg = { n: ++room.cseq, id: p.id, name: p.name, text, ts: now };
    room.chat.push(msg);
    if (room.chat.length > CHAT_KEEP) room.chat.shift();
    for (const q of room.players.values()) if (q.ws) send(q.ws, { t: "chat", m: msg });
    return;
  }

  switch (m.t) {
    case "vjoin":
      if (room.voice.has(p.id)) return;
      room.voice.set(p.id, ++room.vseq);
      break;
    case "vleave":
      if (!room.voice.delete(p.id)) return;
      break;
=======
  switch (m.t) {
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
    case "cfg": {
      if (!host || room.phase !== "lobby") return;
      const cfg = validCfg(m);
      if (!cfg) return;
      room.cfg = cfg;
      break;
    }
    case "deal": {
      const ok = room.phase === "lobby" || (room.phase === "result" && room.result && room.result.oc !== "ask");
      if (!host || !ok) return;
      if (!deal(room)) return err(ws, `Need at least ${MIN_PLAYERS} players connected.`);
      break;
    }
    case "seen":
      if (room.phase !== "deal" || !inRound) return;
      room.seen.add(p.id);
      break;
    case "clues":
      if (!host || room.phase !== "deal") return;
      room.phase = "clues";
      room.turn = 0;
      break;
    case "clue": {
      if (room.phase !== "clues" || room.mode !== "online" || speakerId(room) !== p.id) return;
      const text = String(m.text == null ? "" : m.text).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60);
      room.clues.push({ id: p.id, round: Math.floor(room.turn / room.order.length) + 1, text: text || "(no clue)" });
      advance(room);
      break;
    }
    case "done":
      if (room.phase !== "clues" || room.mode !== "f2f" || speakerId(room) !== p.id) return;
      advance(room);
      break;
    case "skip": {
      if (!host || room.phase !== "clues") return;
      if (room.mode === "online") {
        room.clues.push({ id: speakerId(room), round: Math.floor(room.turn / room.order.length) + 1, text: "(skipped)" });
      }
      advance(room);
      break;
    }
    case "tovote":
      if (!host || room.phase !== "clues") return;
      room.phase = "vote";
      break;
    case "vote": {
      if (room.phase !== "vote" || !inRound || room.votes.has(p.id)) return;
      const picks = Array.isArray(m.picks) ? [...new Set(m.picks.filter((x) => typeof x === "string"))] : [];
      if (picks.length !== room.k || picks.some((id) => id === p.id || !room.roundIds.includes(id))) return;
      room.votes.set(p.id, picks);
      checkVotes(room);
      break;
    }
    case "reveal":
      if (!host || room.phase !== "vote") return;
      reveal(room);
      break;
    case "guess": {
      if (!host || room.phase !== "result" || !room.result || room.result.oc !== "ask") return;
      if (m.ok === true) {
        room.result.oc = "steal";
        addScore(room, [...room.impSet], 2);
      } else {
        room.result.oc = "group";
        addScore(room, room.roundIds.filter((id) => !room.impSet.has(id)), 1);
      }
      break;
    }
    case "lobby":
      if (!host) return;
      room.phase = "lobby";
      break;
    case "reset":
      if (!host) return;
      room.players.forEach((q) => (q.score = 0));
      room.used.clear();
      room.rd = 0;
      room.phase = "lobby";
      break;
    case "kick":
      if (!host || typeof m.id !== "string" || m.id === p.id || !room.players.has(m.id)) return;
      {
        const target = room.players.get(m.id);
        if (target.ws) send(target.ws, { t: "kicked" });
      }
      removePlayer(room, m.id);
      break;
    case "leave":
      removePlayer(room, p.id);
      if (rooms.has(room.code)) push(room);
      return;
    default:
      return;
  }
  push(room);
}

function onClose(ws) {
  const c = ws.ctx;
  if (!c) return;
  const { room, id } = c;
  const p = room.players.get(id);
  if (!p || p.ws !== ws) return;
  p.ws = null;
<<<<<<< HEAD
  room.voice.delete(id);
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
  promoteHost(room);
  if (!connected(room).length) room.emptySince = Date.now();
  checkVotes(room);
  push(room);
}

/* ---------------- sockets ---------------- */
<<<<<<< HEAD
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16384 });
=======
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 2048 });
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.on("pong", () => (ws.isAlive = true));
  let budget = 30;
<<<<<<< HEAD
  let rtcBudget = 400; // voice setup sends many small messages in a burst
  let last = Date.now();
  ws.on("message", (raw) => {
    const now = Date.now();
    const dt = now - last;
    last = now;
    budget = Math.min(30, budget + dt / 100);
    rtcBudget = Math.min(400, rtcBudget + dt / 25);
=======
  let last = Date.now();
  ws.on("message", (raw) => {
    const now = Date.now();
    budget = Math.min(30, budget + (now - last) / 100);
    last = now;
    if (--budget < 0) return;
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object" || typeof m.t !== "string") return;
<<<<<<< HEAD
    if (m.t === "rtc") {
      if (--rtcBudget < 0) return;
    } else if (--budget < 0) return;
=======
>>>>>>> 8071db8ab4a0a4729c7eb99f9315952d78713583
    try {
      handle(ws, m);
    } catch (e) {
      console.error("handler error:", e);
    }
  });
  ws.on("close", () => onClose(ws));
  ws.on("error", () => {});
});

// Drop dead phone connections quickly so players show as offline.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 25000).unref();

// Remove rooms nobody has been in for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!connected(room).length && room.emptySince && now - room.emptySince > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 60000).unref();

server.listen(PORT, () => console.log(`Odd Word Out running on port ${PORT}`));

module.exports = { server, rooms };
