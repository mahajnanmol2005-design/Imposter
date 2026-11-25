"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const WORDS_FILE = path.join(ROOT, "words.json");

const MAX_PLAYERS = 20;
const MAX_ROOMS = 1000;
const MAX_CHAT = 80;
const ROOM_IDLE_MS = 30 * 60 * 1000;
const MAX_MESSAGE = 64 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};

const rooms = new Map();

function randomId() {
  return crypto.randomBytes(12).toString("hex");
}

function randomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code = "";

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function safeText(value, max = 120) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function send(ws, data) {
  if (!ws || ws.readyState !== 1) return;

  try {
    ws.send(JSON.stringify(data));
  } catch (err) {
    console.error("WebSocket send error:", err.message);
  }
}

function broadcast(room, data) {
  for (const p of room.players) {
    send(p.ws, data);
  }
}

function getPlayer(room, id) {
  return room.players.find(p => p.id === id);
}

function getByToken(room, token) {
  return room.players.find(p => p.token === token);
}

function connectedPlayers(room) {
  return room.players.filter(p => p.ws && p.ws.readyState === 1);
}

function loadWords() {
  try {
    const raw = fs.readFileSync(WORDS_FILE, "utf8");
    const data = JSON.parse(raw);

    if (!data || !Array.isArray(data.cats) || !data.pairs) {
      throw new Error("Invalid words.json structure");
    }

    return data;
  } catch (err) {
    console.error("Could not load words.json:", err.message);
    return { cats: [["mixed", "Mixed"]], pairs: {} };
  }
}

const WORDS = loadWords();

function validCfg(cfg) {
  if (!cfg || typeof cfg !== "object") return false;

  const cats = Array.isArray(cfg.cats) ? cfg.cats : ["mixed"];

  return (
    cats.length > 0 &&
    cats.length <= 50 &&
    Number.isInteger(Number(cfg.imps)) &&
    Number(cfg.imps) >= 1 &&
    Number(cfg.imps) <= 10 &&
    Number.isInteger(Number(cfg.rounds)) &&
    Number(cfg.rounds) >= 1 &&
    Number(cfg.rounds) <= 20 &&
    typeof cfg.mode === "string"
  );
}

function getPairs(category) {
  const pairs = WORDS.pairs[category];

  if (!Array.isArray(pairs)) return [];

  return pairs.filter(pair =>
    Array.isArray(pair) &&
    pair.length >= 2 &&
    pair[0] != null &&
    pair[1] != null
  );
}

function chooseWordPair(room) {
  let cats = Array.isArray(room.cfg.cats)
    ? room.cfg.cats
    : ["mixed"];

  if (!cats.length) cats = ["mixed"];

  let all = [];

  if (cats.includes("mixed")) {
    for (const category of Object.keys(WORDS.pairs)) {
      all = all.concat(getPairs(category));
    }
  } else {
    for (const category of cats) {
      all = all.concat(getPairs(category));
    }
  }

  if (!all.length) {
    all = getPairs("mixed");
  }

  if (!all.length) {
    for (const category of Object.keys(WORDS.pairs)) {
      all = all.concat(getPairs(category));
    }
  }

  if (!all.length) {
    return ["Apple", "Orange"];
  }

  return all[Math.floor(Math.random() * all.length)];
}

function createRoom(host) {
  let code;

  do {
    code = randomCode();
  } while (rooms.has(code));

  const room = {
    code,
    hostId: host.id,
    players: [host],

    cfg: {
      cats: ["mixed"],
      imps: 2,
      rounds: 2,
      mode: "f2f"
    },

    phase: "lobby",
    rd: 0,
    mode: "f2f",
    rounds: 2,
    k: 0,
    civ: "",
    imp: "",
    roundIds: [],
    impSet: [],
    order: [],
    turn: 0,
    clues: [],
    votes: {},
    seen: {},
    result: null,

    chat: [],
    chatSeq: 0,
    voiceSeq: 0,

    lastActivity: Date.now()
  };

  rooms.set(code, room);

  return room;
}

function touch(room) {
  room.lastActivity = Date.now();
}

function view(room, viewerId) {
  const player = getPlayer(room, viewerId);

  const players = room.players.map(p => ({
    id: p.id,
    name: p.name,
    on: !!(p.ws && p.ws.readyState === 1),
    score: p.score || 0,
    inRound: room.roundIds.includes(p.id),
    v: p.v || 0
  }));

  const state = {
    code: room.code,
    host: room.hostId,
    hostId: room.hostId,
    players,
    cats: WORDS.cats,
    cfg: room.cfg,

    phase: room.phase,
    rd: room.rd,
    mode: room.mode,
    rounds: room.rounds,
    k: room.k,

    order: room.order,
    turn: room.turn,
    clues: room.clues,
    votes: room.votes,
    voted: Object.keys(room.votes),
    myVotes: room.votes[viewerId] || [],
    seen: Object.keys(room.seen).filter(id => room.seen[id]),
    result: room.result,

    chatCount: room.chatSeq
  };

  if (player) {
    state.me = player.id;
    state.id = player.id;
    state.score = player.score || 0;

    if (room.phase !== "lobby" && room.roundIds.includes(player.id)) {
      state.role = room.impSet.includes(player.id)
        ? "imposter"
        : "civilian";

      if (room.seen[player.id]) {
        state.word = room.seen[player.id];
      }
    }

    if (room.phase === "result") {
      state.civ = room.civ;
      state.imp = room.imp;
      state.impSet = room.impSet;
      state.result = room.result;
    }
  }

  return state;
}

function push(room) {
  touch(room);

  for (const p of room.players) {
    send(p.ws, Object.assign({ t: "state" }, view(room, p.id)));
  }
}

function errorTo(ws, message) {
  send(ws, { t: "err", msg: safeText(message, 300) });
}

function sendJoined(ws, room, player) {
  send(ws, {
    t: "joined",
    code: room.code,
    id: player.id,
    token: player.token
  });

  send(ws, Object.assign({ t: "state" }, view(room, player.id)));

  send(ws, {
    t: "chatlog",
    log: room.chat
  });
}

function createPlayer(name) {
  return {
    id: randomId(),
    token: randomId(),
    name: safeText(name, 24) || "Player",
    ws: null,
    score: 0,
    v: 0
  };
}

function addPlayer(room, player) {
  if (room.players.length >= MAX_PLAYERS) {
    return false;
  }

  room.players.push(player);
  touch(room);

  return true;
}

function promoteHost(room) {
  const online = connectedPlayers(room);

  if (online.length) {
    room.hostId = online[0].id;
  } else if (room.players.length) {
    room.hostId = room.players[0].id;
  } else {
    room.hostId = null;
  }
}

function removePlayer(room, player, disconnect = false) {
  if (!player) return;

  const wasHost = player.id === room.hostId;

  room.players = room.players.filter(p => p.id !== player.id);

  room.roundIds = room.roundIds.filter(id => id !== player.id);
  room.impSet = room.impSet.filter(id => id !== player.id);
  room.order = room.order.filter(id => id !== player.id);

  delete room.seen[player.id];
  delete room.votes[player.id];

  for (const key of Object.keys(room.votes)) {
    if (Array.isArray(room.votes[key])) {
      room.votes[key] = room.votes[key].filter(id => id !== player.id);
    }
  }

  room.clues = room.clues.filter(c => c.id !== player.id);

  if (wasHost) promoteHost(room);

  if (!room.players.length) {
    rooms.delete(room.code);
    return;
  }

  if (room.phase === "clues") {
    if (room.turn >= room.order.length * room.rounds) {
      startVote(room);
    }
  }

  if (room.phase === "vote") {
    checkVotes(room);
  }

  touch(room);
  push(room);
}

function resetRound(room) {
  room.rd = 0;
  room.phase = "lobby";
  room.roundIds = [];
  room.impSet = [];
  room.order = [];
  room.turn = 0;
  room.clues = [];
  room.votes = {};
  room.seen = {};
  room.result = null;
  room.civ = "";
  room.imp = "";
}

function startGame(room) {
  const players = connectedPlayers(room);

  if (players.length < 4) {
    return false;
  }

  const impCount = Math.min(
    Number(room.cfg.imps) || 1,
    players.length - 1
  );

  room.rounds = Number(room.cfg.rounds) || 1;
  room.mode = room.cfg.mode || "f2f";

  room.rd = 1;
  room.k = impCount;
  room.phase = "deal";

  room.roundIds = players.map(p => p.id);
  room.order = players.map(p => p.id);

  room.turn = 0;
  room.clues = [];
  room.votes = {};
  room.seen = {};
  room.result = null;

  const pair = chooseWordPair(room);

  room.civ = safeText(pair[0], 100);
  room.imp = safeText(pair[1], 100);

  const shuffled = players.slice();

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  room.impSet = shuffled.slice(0, impCount).map(p => p.id);

  for (const p of players) {
    room.seen[p.id] = room.impSet.includes(p.id)
      ? room.imp
      : room.civ;
  }

  room.phase = "deal";

  touch(room);
  push(room);

  return true;
}

function startVote(room) {
  room.phase = "vote";
  room.votes = {};
  room.turn = 0;
  touch(room);
  push(room);
}

function countVotes(room) {
  const counts = {};

  for (const voter of room.roundIds) {
    const picks = room.votes[voter] || [];

    for (const target of picks) {
      counts[target] = (counts[target] || 0) + 1;
    }
  }

  return counts;
}

function finishVote(room) {
  const counts = countVotes(room);

  const ranked = room.roundIds
    .map(id => [id, counts[id] || 0])
    .sort((a, b) => b[1] - a[1]);

  const top = ranked.length ? ranked[0][1] : 0;

  const acc = ranked
    .filter(x => x[1] === top && top > 0)
    .map(x => x[0]);

  const caughtImps = acc.filter(id => room.impSet.includes(id));
  const caught = caughtImps.length > 0;

  let oc = caught ? "ask" : "escape";

  if (!caught) {
    for (const p of room.players) {
      if (room.impSet.includes(p.id)) {
        p.score = (p.score || 0) + 3;
      }
    }
  }

  room.result = {
    oc,
    imps: room.impSet.slice(),
    acc,
    tally: counts,
    civ: room.civ,
    imp: room.imp,
    guessCorrect: null
  };

  room.phase = "result";
  touch(room);
  push(room);
}

function checkVotes(room) {
  if (room.phase !== "vote") return;

  const active = room.roundIds.filter(id => getPlayer(room, id));

  if (
    active.length &&
    active.every(id =>
      Array.isArray(room.votes[id]) &&
      room.votes[id].length === room.k
    )
  ) {
    finishVote(room);
  }
}

function advance(room) {
  if (room.phase === "result") {
    if (room.rd >= room.rounds) {
      resetRound(room);
      push(room);
      return;
    }

    room.rd++;
  }

  const players = connectedPlayers(room);

  if (players.length < 4) {
    resetRound(room);
    push(room);
    return;
  }

  room.roundIds = players.map(p => p.id);
  room.order = players.map(p => p.id);

  room.turn = 0;
  room.clues = [];
  room.votes = {};
  room.seen = {};
  room.result = null;

  room.k = Math.min(Number(room.cfg.imps) || 1, players.length - 1);

  const pair = chooseWordPair(room);

  room.civ = safeText(pair[0], 100);
  room.imp = safeText(pair[1], 100);

  const shuffled = players.slice();

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  room.impSet = shuffled.slice(0, room.k).map(p => p.id);

  for (const p of players) {
    room.seen[p.id] = room.impSet.includes(p.id)
      ? room.imp
      : room.civ;
  }

  room.phase = "deal";

  touch(room);
  push(room);
}

function handleChat(room, player, message) {
  const text = safeText(message.text, 500);

  if (!text) return;

  const m = {
    n: ++room.chatSeq,
    id: player.id,
    name: player.name,
    text,
    at: Date.now()
  };

  room.chat.push(m);

  if (room.chat.length > MAX_CHAT) {
    room.chat.shift();
  }

  broadcast(room, {
    t: "chat",
    m
  });

  touch(room);
}

function handleVoiceJoin(room, player) {
  if (!player.v) {
    player.v = ++room.voiceSeq;
  }

  touch(room);
  push(room);
}

function handleVoiceLeave(room, player) {
  player.v = 0;

  touch(room);
  push(room);
}

function handleRTC(room, player, message) {
  const targetId = safeText(message.to, 100);
  const target = getPlayer(room, targetId);

  if (!target || target.id === player.id) return;
  if (!target.ws || target.ws.readyState !== 1) return;
  if (!player.v || !target.v) return;

  if (!message.d || typeof message.d !== "object") return;

  const data = message.d;
  const relay = {};

  if (data.c) relay.c = data.c;
  if (data.o) relay.o = data.o;
  if (data.a) relay.a = data.a;

  if (!Object.keys(relay).length) return;

  send(target.ws, {
    t: "rtc",
    from: player.id,
    d: relay
  });

  touch(room);
}

function handle(room, player, message) {
  if (!room || !player || !message || typeof message !== "object") {
    return;
  }

  touch(room);

  switch (message.t) {
    case "chat":
      handleChat(room, player, message);
      break;

    case "vjoin":
      handleVoiceJoin(room, player);
      break;

    case "vleave":
      handleVoiceLeave(room, player);
      break;

    case "rtc":
      handleRTC(room, player, message);
      break;

    case "cfg": {
      if (room.hostId !== player.id) return;
      if (room.phase !== "lobby") return;

      const cfg = {
        cats: message.cats,
        imps: message.imps,
        rounds: message.rounds,
        mode: message.mode
      };

      if (!validCfg(cfg)) {
        errorTo(player.ws, "Invalid settings");
        return;
      }

      room.cfg = {
        cats: Array.isArray(cfg.cats) && cfg.cats.length
          ? cfg.cats.slice(0, 50).map(x => safeText(x, 60))
          : ["mixed"],

        imps: Math.max(1, Math.min(10, Number(cfg.imps) || 1)),
        rounds: Math.max(1, Math.min(20, Number(cfg.rounds) || 1)),
        mode: safeText(cfg.mode, 30) || "f2f"
      };

      push(room);
      break;
    }

    case "deal": {
      if (room.hostId !== player.id) return;

      if (!startGame(room)) {
        errorTo(player.ws, "At least 4 online players are required.");
      }

      break;
    }

    case "seen":
      if (room.phase !== "deal") return;
      if (!room.roundIds.includes(player.id)) return;
      push(room);
      break;

    case "clues":
      if (room.hostId !== player.id || room.phase !== "deal") return;

      room.phase = "clues";
      room.turn = 0;
      push(room);
      break;

    case "clue": {
      if (room.phase !== "clues") return;
      if (!room.roundIds.includes(player.id)) return;

      const text = safeText(message.text || message.clue, 100);

      if (!text) return;

      const n = room.order.length;
      const currentId = room.order[room.turn % n];

      if (currentId !== player.id) return;

      room.clues.push({
        id: player.id,
        name: player.name,
        text,
        round: Math.floor(room.turn / n) + 1
      });

      room.turn++;

      if (room.turn >= n * room.rounds) {
        startVote(room);
      } else {
        push(room);
      }

      break;
    }

    case "done":
      if (
        room.phase !== "clues" ||
        room.turn >= room.order.length * room.rounds
      ) return;

      if (room.order[room.turn % room.order.length] !== player.id) return;

      room.turn++;

      if (room.turn >= room.order.length * room.rounds) {
        startVote(room);
      } else {
        push(room);
      }

      break;

    case "skip":
      if (room.phase !== "clues" || room.hostId !== player.id) return;
      if (room.turn >= room.order.length * room.rounds) return;

      room.turn++;

      if (room.turn >= room.order.length * room.rounds) {
        startVote(room);
      } else {
        push(room);
      }

      break;

    case "tovote":
      if (room.hostId === player.id && room.phase === "clues") {
        startVote(room);
      }
      break;

    case "vote": {
      if (room.phase !== "vote") return;

      const picks = Array.isArray(message.picks)
        ? message.picks.slice(0, room.k).map(x => safeText(x, 100))
        : [];

      if (picks.length !== room.k) return;
      if (new Set(picks).size !== picks.length) return;

      if (
        picks.some(id =>
          !room.roundIds.includes(id) ||
          id === player.id
        )
      ) return;

      if (room.votes[player.id]) return;

      room.votes[player.id] = picks;

      push(room);
      checkVotes(room);
      break;
    }

    case "reveal":
      if (room.phase !== "vote") return;

      if (room.hostId === player.id) {
        finishVote(room);
      }

      break;

    case "guess":
      if (room.phase !== "result" || room.result.oc !== "ask") return;
      if (!room.impSet.includes(player.id)) return;

      if (message.ok === true) {
        for (const id of room.impSet) {
          const p = getPlayer(room, id);

          if (p) {
            p.score = (p.score || 0) + 2;
          }
        }

        room.result.oc = "steal";
      } else {
        for (const p of room.players) {
          if (!room.impSet.includes(p.id)) {
            p.score = (p.score || 0) + 1;
          }
        }

        room.result.oc = "group";
      }

      room.result.guessCorrect = message.ok === true;
      push(room);
      break;

    case "lobby":
      if (room.hostId !== player.id) return;

      resetRound(room);
      push(room);
      break;

    case "reset":
      if (room.hostId !== player.id) return;

      for (const p of room.players) {
        p.score = 0;
      }

      resetRound(room);
      push(room);
      break;

    case "kick": {
      if (room.hostId !== player.id) return;

      const targetId = safeText(message.id || message.to, 100);
      const target = getPlayer(room, targetId);

      if (!target || target.id === player.id) return;

      send(target.ws, { t: "kicked" });

      removePlayer(room, target);

      if (target.ws && target.ws.readyState === 1) {
        target.ws.close();
      }

      break;
    }

    case "leave":
      removePlayer(room, player);

      if (player.ws && player.ws.readyState === 1) {
        player.ws.close();
      }

      break;

    default:
      break;
  }
}

function reconnect(room, token, ws) {
  const player = getByToken(room, token);

  if (!player) return null;

  if (player.ws && player.ws !== ws) {
    try {
      player.ws.close();
    } catch (_) {}
  }

  player.ws = ws;
  player.v = 0;

  touch(room);

  sendJoined(ws, room, player);
  push(room);

  return player;
}

function onClose(room, player, ws) {
  if (!room || !player) return;

  // Ignore an old connection closing after a reconnect.
  if (player.ws !== ws) return;

  player.ws = null;
  player.v = 0;

  touch(room);

  if (player.id === room.hostId) {
    promoteHost(room);
  }

  push(room);
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (_) {
    return null;
  }
}

function handleConnection(ws) {
  let room = null;
  let player = null;

  ws.on("message", raw => {
    if (raw.length > MAX_MESSAGE) {
      ws.close(1009, "Message too large");
      return;
    }

    const message = parseMessage(raw);

    if (!message || typeof message !== "object") {
      return;
    }

    // Create a new room.
    if (message.t === "create") {
      if (room || player) return;

      if (rooms.size >= MAX_ROOMS) {
        errorTo(ws, "Server is full. Try again later.");
        return;
      }

      player = createPlayer(message.name);
      player.ws = ws;

      room = createRoom(player);

      sendJoined(ws, room, player);
      push(room);

      return;
    }

    // Join an existing room.
    if (message.t === "join") {
      if (room || player) return;

      const code = safeText(message.code, 10).toUpperCase();
      const token = safeText(message.token, 100);

      room = rooms.get(code);

      if (!room) {
        errorTo(ws, "Room not found.");
        room = null;
        return;
      }

      if (token) {
        player = reconnect(room, token, ws);

        if (player) {
          push(room);
          return;
        }
      }

      if (room.phase !== "lobby") {
        errorTo(ws, "This game is already in progress.");
        room = null;
        return;
      }

      if (room.players.length >= MAX_PLAYERS) {
        errorTo(ws, "Room is full.");
        room = null;
        return;
      }

      player = createPlayer(message.name);
      player.ws = ws;

      if (!addPlayer(room, player)) {
        errorTo(ws, "Room is full.");
        room = null;
        player = null;
        return;
      }

      sendJoined(ws, room, player);
      push(room);

      return;
    }

    // All other messages require room/player authentication.
    if (!room || !player) return;

    if (player.ws !== ws) return;

    handle(room, player, message);
  });

  ws.on("close", () => {
    onClose(room, player, ws);
  });

  ws.on("error", err => {
    console.warn("WebSocket error:", err.message);
  });
}

/* ---------------- HTTP ---------------- */

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/healthz") {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store"
    });

    res.end("ok");
    return;
  }

  // WebRTC ICE server configuration.
  if (pathname === "/ice") {
    const ice = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ];

    const turnUrls = safeText(process.env.TURN_URLS, 1000);
    const turnUsername = safeText(process.env.TURN_USERNAME, 300);
    const turnCredential = safeText(process.env.TURN_CREDENTIAL, 500);

    if (turnUrls && turnUsername && turnCredential) {
      const urls = turnUrls
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);

      if (urls.length) {
        ice.push({
          urls,
          username: turnUsername,
          credential: turnCredential
        });
      }
    }

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });

    res.end(JSON.stringify({ ice }));
    return;
  }

  // Serve static files from /public.
  let filePath;

  if (pathname === "/") {
    filePath = path.join(PUBLIC, "index.html");
  } else {
    const relative = decodeURIComponent(pathname)
      .replace(/^\/+/, "");

    filePath = path.join(PUBLIC, relative);
  }

  const resolved = path.resolve(filePath);

  if (
    !resolved.startsWith(path.resolve(PUBLIC) + path.sep) &&
    resolved !== path.resolve(PUBLIC, "index.html")
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain; charset=utf-8"
      });

      res.end(err.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    const ext = path.extname(resolved).toLowerCase();

    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html"
        ? "no-cache"
        : "public, max-age=3600"
    });

    res.end(data);
  });
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_MESSAGE
});

wss.on("connection", handleConnection);

// Heartbeat: remove dead WebSocket connections.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;

    try {
      ws.ping();
    } catch (_) {
      ws.terminate();
    }
  }
}, 30000);

wss.on("connection", ws => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });
});

// Remove empty/stale rooms.
const cleanup = setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms) {
    const online = connectedPlayers(room);

    if (
      online.length === 0 &&
      now - room.lastActivity > ROOM_IDLE_MS
    ) {
      rooms.delete(code);
    }
  }
}, 60000);

server.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(cleanup);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Odd Word Out server listening on port ${PORT}`);
});