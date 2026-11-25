
"use strict";

/*
 * Odd Word Out server
 * HTTP static files + WebSocket game rooms, chat and WebRTC signaling.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const WORDS = require("./words.json");
const PAIRS = WORDS.pairs || {};
const CAT_IDS = new Set(["mixed", ...Object.keys(PAIRS)]);

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 4;
const MAX_ROOMS = 1000;
const ROOM_IDLE_MS = 30 * 60 * 1000;
const MAX_CHAT = 80;

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
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const rooms = new Map();
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/* ---------------- HTTP server ---------------- */

const server = http.createServer((req, res) => {
  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname
    );
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (pathname === "/healthz") {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    res.end("ok");
    return;
  }

  // STUN configuration for the existing frontend.
  if (pathname === "/ice") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "self",
    });

    res.end(JSON.stringify({
      ice: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    }));
    return;
  }

  if (pathname === "/") pathname = "/index.html";

  const file = path.resolve(PUB, "." + pathname);

  if (file !== PUB && !file.startsWith(PUB + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Not found");
      return;
    }

    const revalidate = [
      "/sw.js",
      "/index.html",
      "/app.js",
      "/style.css",
    ].includes(pathname);

    res.writeHead(200, {
      "Content-Type":
        MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": revalidate ? "no-cache" : "public, max-age=3600",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });

    res.end(data);
  });
});

/* ---------------- helpers ---------------- */

function newCode() {
  for (let i = 0; i < 60; i++) {
    let code = "";

    for (let j = 0; j < 4; j++) {
      code += LETTERS[crypto.randomInt(LETTERS.length)];
    }

    if (!rooms.has(code)) return code;
  }

  return null;
}

function newToken() {
  return crypto.randomBytes(16).toString("hex");
}

function shuffle(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function cleanName(value) {
  const name = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);

  return name || "Player";
}

function cleanChat(value) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 200);
}

function send(ws, message) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message, exceptId) {
  for (const player of room.players.values()) {
    if (player.id !== exceptId && player.ws) {
      send(player.ws, message);
    }
  }
}

function makeRoom(code) {
  return {
    code,
    hostId: null,
    players: new Map(),

    seq: 0,
    voiceSeq: 0,
    chat: [],

    cfg: {
      cats: ["mixed"],
      imps: 2,
      rounds: 2,
      mode: "f2f",
    },

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
  };
}

function addPlayer(room, name, ws) {
  const base = cleanName(name);
  let playerName = base;
  let number = 2;

  const taken = () =>
    [...room.players.values()].some(
      (p) => p.name.toLowerCase() === playerName.toLowerCase()
    );

  while (taken()) {
    playerName = base.slice(0, 13) + " " + number++;
  }

  const player = {
    id: newToken(),
    token: newToken(),
    name: playerName,
    ws,
    score: 0,
    v: 0,
  };

  room.players.set(player.id, player);
  return player;
}

function connected(room) {
  return [...room.players.values()].filter((p) => p.ws);
}

function promoteHost(room) {
  const current = room.players.get(room.hostId);

  if (current && current.ws) return;

  const next = connected(room)[0];
  room.hostId = next ? next.id : null;
}

function addScore(room, ids, amount) {
  for (const id of ids) {
    const player = room.players.get(id);
    if (player) player.score += amount;
  }
}

/* ---------------- word selection ---------------- */

function pickPair(room) {
  let categories = room.cfg.cats;

  if (categories.includes("mixed")) {
    categories = Object.keys(PAIRS);
  }

  let options = [];

  for (const category of categories) {
    const pairs = PAIRS[category];

    if (!Array.isArray(pairs)) continue;

    pairs.forEach((pair, index) => {
      if (!room.used.has(`${category}:${index}`)) {
        options.push({
          pair,
          key: `${category}:${index}`,
        });
      }
    });
  }

  if (!options.length) {
    room.used.clear();

    for (const category of categories) {
      const pairs = PAIRS[category];

      if (!Array.isArray(pairs)) continue;

      pairs.forEach((pair, index) => {
        options.push({
          pair,
          key: `${category}:${index}`,
        });
      });
    }
  }

  if (!options.length) return null;

  const selected = options[crypto.randomInt(options.length)];
  room.used.add(selected.key);

  return selected.pair;
}

/* ---------------- player state ---------------- */

function view(room, player) {
  const live = room.phase !== "lobby";
  const inRound = live && room.roundIds.includes(player.id);

  const state = {
    t: "state",
    code: room.code,
    me: player.id,
    hostId: room.hostId,
    host: room.hostId === player.id,
    phase: room.phase,
    rd: room.rd,
    cfg: room.cfg,

    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      on: !!p.ws,
      score: p.score,
      v: p.ws ? p.v : 0,
      inRound: live && room.roundIds.includes(p.id),
    })),
  };

  if (state.host) state.cats = WORDS.cats;

  if (live) {
    state.k = room.k;
    state.rounds = room.rounds;
    state.mode = room.mode;
    state.order = room.order;
    state.turn = room.turn;
    state.clues = room.clues;
    state.seen = [...room.seen];
    state.voted = [...room.votes.keys()];
    state.myVotes = room.votes.get(player.id) || [];

    if (inRound && room.phase !== "result") {
      state.word = room.impSet.has(player.id) ? room.imp : room.civ;
    }

    if (room.phase === "result" && room.result) {
      const result = room.result;

      state.result = {
        oc: result.oc,
        imps: [...room.impSet],
        acc: result.acc,
        tally: result.tally,
      };

      if (result.oc !== "ask") {
        state.result.civ = room.civ;
        state.result.imp = room.imp;
      }
    }
  }

  return state;
}

function push(room) {
  for (const player of room.players.values()) {
    if (player.ws) send(player.ws, view(room, player));
  }
}

function sendChatLog(room, player) {
  send(player.ws, {
    t: "chatlog",
    log: room.chat,
  });
}

/* ---------------- game logic ---------------- */

function deal(room) {
  const players = connected(room);

  if (players.length < MIN_PLAYERS) return false;

  const pair = pickPair(room);

  if (!pair || pair.length !== 2) return false;

  const flip = crypto.randomInt(2) === 1;
  const ids = players.map((p) => p.id);

  room.rd++;
  room.mode = room.cfg.mode;
  room.rounds = room.cfg.rounds;
  room.roundIds = ids;

  room.k = Math.min(
    room.cfg.imps,
    Math.floor((ids.length - 1) / 2)
  );

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

function speakerId(room) {
  return room.order.length
    ? room.order[room.turn % room.order.length]
    : null;
}

function advance(room) {
  room.turn++;

  if (room.turn >= room.order.length * room.rounds) {
    room.phase = "vote";
  }
}

function reveal(room) {
  if (room.phase !== "vote") return;

  const tally = {};

  room.roundIds.forEach((id) => {
    tally[id] = 0;
  });

  for (const picks of room.votes.values()) {
    picks.forEach((id) => {
      if (id in tally) tally[id]++;
    });
  }

  const accepted = shuffle(room.roundIds)
    .sort((a, b) => tally[b] - tally[a])
    .slice(0, room.k);

  const caught = [...room.impSet].every((id) => accepted.includes(id));

  room.result = {
    oc: caught ? "ask" : "survive",
    acc: accepted,
    tally,
  };

  if (!caught) {
    addScore(room, [...room.impSet], 3);
  }

  room.phase = "result";
}

function checkVotes(room) {
  if (room.phase !== "vote") return;

  const required = room.roundIds.filter((id) => {
    const player = room.players.get(id);
    return player && player.ws;
  });

  if (
    required.length &&
    required.every((id) => room.votes.has(id))
  ) {
    reveal(room);
  }
}

function removePlayer(room, id) {
  const player = room.players.get(id);
  if (!player) return;

  if (player.ws) {
    const oldSocket = player.ws;
    player.ws = null;
    oldSocket.ctx = null;

    try {
      oldSocket.close();
    } catch {}
  }

  player.v = 0;
  room.players.delete(id);

  if (!room.players.size) {
    rooms.delete(room.code);
    return;
  }

  promoteHost(room);
  checkVotes(room);
  push(room);
}

function validCfg(message) {
  if (
    !Array.isArray(message.cats) ||
    message.cats.length < 1 ||
    message.cats.length > 40
  ) {
    return null;
  }

  let cats = [
    ...new Set(
      message.cats.filter(
        (category) =>
          typeof category === "string" && CAT_IDS.has(category)
      )
    ),
  ];

  if (!cats.length) return null;
  if (cats.includes("mixed")) cats = ["mixed"];

  return {
    cats,
    imps: message.imps === 2 ? 2 : 1,
    rounds: [1, 2, 3].includes(message.rounds)
      ? message.rounds
      : 2,
    mode: message.mode === "online" ? "online" : "f2f",
  };
}

/* ---------------- errors ---------------- */

function err(ws, message, fatal) {
  send(ws, {
    t: "err",
    msg: message,
    fatal: !!fatal,
  });
}

/* ---------------- chat ---------------- */

function handleChat(room, player, message) {
  const text = cleanChat(message.text);

  if (!text) return;

  const chatMessage = {
    n: ++room.seq,
    id: player.id,
    name: player.name,
    text,
  };

  room.chat.push(chatMessage);

  if (room.chat.length > MAX_CHAT) {
    room.chat.shift();
  }

  broadcast(room, {
    t: "chat",
    m: chatMessage,
  });
}

/* ---------------- voice chat ---------------- */

function joinVoice(room, player) {
  if (player.v) return;

  room.voiceSeq++;
  player.v = room.voiceSeq;

  push(room);
}

function leaveVoice(room, player) {
  if (!player.v) return;

  player.v = 0;

  // Tell the other clients to close this player's peer connection.
  push(room);
}

function relayRtc(room, player, message) {
  const targetId = message.to;

  if (typeof targetId !== "string" || !message.d || typeof message.d !== "object") {
    return;
  }

  const target = room.players.get(targetId);

  if (
    !target ||
    !target.ws ||
    !player.v ||
    !target.v ||
    target.id === player.id
  ) {
    return;
  }

  const data = message.d;

  // Only allow the WebRTC fields used by the frontend.
  const valid =
    ("o" in data && data.o) ||
    ("a" in data && data.a) ||
    ("c" in data && data.c);

  if (!valid) return;

  send(target.ws, {
    t: "rtc",
    from: player.id,
    d: data,
  });
}

/* ---------------- WebSocket message handler ---------------- */

function handle(ws, message) {
  if (message.t === "create") {
    if (ws.ctx) return;

    if (rooms.size >= MAX_ROOMS) {
      return err(ws, "The server is busy. Try again later.");
    }

    const code = newCode();

    if (!code) {
      return err(ws, "Could not create a game code. Try again.");
    }

    const room = makeRoom(code);
    rooms.set(code, room);

    const player = addPlayer(room, message.name, ws);

    room.hostId = player.id;
    ws.ctx = { room, id: player.id };

    send(ws, {
      t: "joined",
      code,
      token: player.token,
    });

    sendChatLog(room, player);
    push(room);
    return;
  }

  if (message.t === "join") {
    const code = String(message.code || "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 4);

    const room = rooms.get(code);

    if (!room) {
      return err(ws, "No game with that code. Check it and try again.", true);
    }

    let player = null;

    if (typeof message.token === "string" && message.token) {
      for (const existing of room.players.values()) {
        if (existing.token === message.token) {
          player = existing;
          break;
        }
      }
    }

    if (player) {
      if (player.ws && player.ws !== ws) {
        player.ws.ctx = null;

        try {
          player.ws.close();
        } catch {}
      }

      player.ws = ws;
    } else {
      if (ws.ctx) return;

      if (room.players.size >= MAX_PLAYERS) {
        return err(ws, "That game is full.", true);
      }

      player = addPlayer(room, message.name, ws);
    }

    ws.ctx = {
      room,
      id: player.id,
    };

    room.emptySince = null;

    const host = room.players.get(room.hostId);
    if (!host || !host.ws) room.hostId = player.id;

    send(ws, {
      t: "joined",
      code,
      token: player.token,
    });

    sendChatLog(room, player);
    push(room);
    return;
  }

  const context = ws.ctx;
  if (!context) return;

  const room = context.room;
  const player = room.players.get(context.id);

  if (!player || player.ws !== ws) return;

  const isHost = room.hostId === player.id;
  const inRound = room.roundIds.includes(player.id);

  switch (message.t) {
    case "cfg": {
      if (!isHost || room.phase !== "lobby") return;

      const config = validCfg(message);
      if (!config) return;

      room.cfg = config;
      break;
    }

    case "deal": {
      const allowed =
        room.phase === "lobby" ||
        (
          room.phase === "result" &&
          room.result &&
          room.result.oc !== "ask"
        );

      if (!isHost || !allowed) return;

      if (!deal(room)) {
        return err(ws, `Need at least ${MIN_PLAYERS} connected players.`);
      }

      break;
    }

    case "seen":
      if (room.phase !== "deal" || !inRound) return;

      room.seen.add(player.id);
      break;

    case "clues":
      if (!isHost || room.phase !== "deal") return;

      room.phase = "clues";
      room.turn = 0;
      break;

    case "clue": {
      if (
        room.phase !== "clues" ||
        room.mode !== "online" ||
        speakerId(room) !== player.id
      ) {
        return;
      }

      const text = String(message.text == null ? "" : message.text)
        .replace(/[\u0000-\u001f\u007f<>]/g, "")
        .trim()
        .slice(0, 60);

      room.clues.push({
        id: player.id,
        round: Math.floor(room.turn / room.order.length) + 1,
        text: text || "(no clue)",
      });

      advance(room);
      break;
    }

    case "done":
      if (
        room.phase !== "clues" ||
        room.mode !== "f2f" ||
        speakerId(room) !== player.id
      ) {
        return;
      }

      advance(room);
      break;

    case "skip":
      if (!isHost || room.phase !== "clues") return;

      if (room.mode === "online") {
        room.clues.push({
          id: speakerId(room),
          round: Math.floor(room.turn / room.order.length) + 1,
          text: "(skipped)",
        });
      }

      advance(room);
      break;

    case "tovote":
      if (!isHost || room.phase !== "clues") return;

      room.phase = "vote";
      break;

    case "vote": {
      if (
        room.phase !== "vote" ||
        !inRound ||
        room.votes.has(player.id)
      ) {
        return;
      }

      const picks = Array.isArray(message.picks)
        ? [...new Set(
            message.picks.filter((id) => typeof id === "string")
          )]
        : [];

      if (
        picks.length !== room.k ||
        picks.some(
          (id) =>
            id === player.id ||
            !room.roundIds.includes(id)
        )
      ) {
        return;
      }

      room.votes.set(player.id, picks);
      checkVotes(room);
      break;
    }

    case "reveal":
      if (!isHost || room.phase !== "vote") return;

      reveal(room);
      break;

    case "guess":
      if (
        !isHost ||
        room.phase !== "result" ||
        !room.result ||
        room.result.oc !== "ask"
      ) {
        return;
      }

      if (message.ok === true) {
        room.result.oc = "steal";
        addScore(room, [...room.impSet], 2);
      } else {
        room.result.oc = "group";

        addScore(
          room,
          room.roundIds.filter((id) => !room.impSet.has(id)),
          1
        );
      }

      break;

    case "lobby":
      if (!isHost) return;

      room.phase = "lobby";
      break;

    case "reset":
      if (!isHost) return;

      room.players.forEach((p) => {
        p.score = 0;
      });

      room.used.clear();
      room.rd = 0;
      room.phase = "lobby";
      room.roundIds = [];
      room.impSet.clear();
      room.order = [];
      room.turn = 0;
      room.clues = [];
      room.votes.clear();
      room.seen.clear();
      room.result = null;
      break;

    case "kick": {
      if (
        !isHost ||
        typeof message.id !== "string" ||
        message.id === player.id ||
        !room.players.has(message.id)
      ) {
        return;
      }

      const target = room.players.get(message.id);

      if (target.ws) {
        send(target.ws, { t: "kicked" });
      }

      removePlayer(room, message.id);
      return;
    }

    case "leave":
      removePlayer(room, player.id);
      return;

    case "chat":
      handleChat(room, player, message);
      return;

    case "vjoin":
      joinVoice(room, player);
      return;

    case "vleave":
      leaveVoice(room, player);
      return;

    case "rtc":
      relayRtc(room, player, message);
      return;

    default:
      return;
  }

  push(room);
}

/* ---------------- disconnect handling ---------------- */

function onClose(ws) {
  const context = ws.ctx;
  if (!context) return;

  const { room, id } = context;
  const player = room.players.get(id);

  // Ignore old sockets after a player reconnects.
  if (!player || player.ws !== ws) return;

  player.ws = null;
  player.v = 0;
  ws.ctx = null;

  promoteHost(room);
  checkVotes(room);

  if (!connected(room).length) {
    room.emptySince = Date.now();
  }

  push(room);
}

/* ---------------- WebSocket setup ---------------- */

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 16384,
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.ctx = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      typeof message.t !== "string"
    ) {
      return;
    }

    try {
      handle(ws, message);
    } catch (error) {
      console.error("WebSocket handler error:", error);
      err(ws, "Something went wrong. Please try again.");
    }
  });

  ws.on("close", () => onClose(ws));

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});

/* ---------------- heartbeat ---------------- */

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

/* ---------------- room cleanup ---------------- */

setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms) {
    if (
      !connected(room).length &&
      room.emptySince &&
      now - room.emptySince > ROOM_IDLE_MS
    ) {
      rooms.delete(code);
    }
  }
}, 60000).unref();

/* ---------------- start ---------------- */

server.listen(PORT, () => {
  console.log(`Odd Word Out running on port ${PORT}`);
});

module.exports = {
  server,
  rooms,
};
