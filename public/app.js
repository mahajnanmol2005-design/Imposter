"use strict";
(function () {
  var $app = document.getElementById("app");

  /* ---------- small helpers ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

var LS = {
  get: function (k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  },
  set: function (k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {}
  },
  del: function (k) {
    try {
      localStorage.removeItem(k);
    } catch (e) {}
  },
};

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var isStandalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  var S = {
    ws: null, conn: false, st: null, code: null, token: null,
    name: LS.get("oowl-name") || "", joinCode: "", toast: "",
    show: false, draft: "", pick: [], dstate: "idle", dBase: "", micOff: false,
    prevKey: "", installEvt: null, leaveArm: false, copied: false,
    chat: [], readN: 0, chatOpen: false, chatDraft: "",
  };

  var V = { on: false, muted: false, stream: null, pcs: {}, ice: [], starting: false };

  try {
    var sess = JSON.parse(LS.get("oowl-sess") || "null");
    if (sess && sess.code && sess.token) { S.code = sess.code; S.token = sess.token; }
  } catch (e) {}

  var qp = new URLSearchParams(location.search).get("room");
  if (qp) {
    S.joinCode = qp.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    if (S.joinCode !== S.code) { S.code = null; S.token = null; }
  }

  /* ---------- connection ---------- */
  var retry = 0, retryTimer = null;

  function connect() {
    clearTimeout(retryTimer);
    var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
    S.ws = ws;

    ws.onopen = function () {
      S.conn = true; retry = 0;
      if (S.code && S.token) send({ t: "join", code: S.code, token: S.token, name: S.name }, true);
      render();
    };

    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (x) { return; }
      onMsg(m);
    };

    ws.onclose = function () {
      if (S.ws !== ws) return;
      S.conn = false; render();
      retryTimer = setTimeout(connect, Math.min(4000, 400 * Math.pow(2, retry++)));
    };

    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function send(o, quiet) {
    if (S.ws && S.ws.readyState === 1) {
      S.ws.send(JSON.stringify(o));
      return true;
    }
    if (!quiet) flash("Connecting. Try again in a moment.");
    return false;
  }

  function clearSession() {
    teardownVoice();
    S.chat = []; S.readN = 0; S.chatOpen = false; S.chatDraft = "";
    S.st = null; S.code = null; S.token = null; S.show = false; S.pick = []; S.prevKey = "";
    LS.del("oowl-sess");
  }

  function flash(msg) {
    S.toast = msg; render();
    setTimeout(function () {
      if (S.toast === msg) { S.toast = ""; render(); }
    }, 3500);
  }

  function onMsg(m) {
    if (m.t === "joined") {
      S.code = m.code; S.token = m.token;
      LS.set("oowl-sess", JSON.stringify({ code: m.code, token: m.token }));
      if (location.search) history.replaceState(null, "", location.pathname);
    } else if (m.t === "state") {
      S.st = m;
      syncVoice();

      var key = m.phase + ":" + m.rd + ":" + (m.turn || 0);
      if (key !== S.prevKey) {
        var wasMine = false;
        S.prevKey = key; S.show = false; S.pick = []; S.draft = "";
        stopMic();
        var ae = document.activeElement;
        if (ae && ae.blur && ae !== document.body) ae.blur();
        if (m.phase === "clues" && m.order && m.order[m.turn % m.order.length] === m.me) wasMine = true;
        if (wasMine && navigator.vibrate) navigator.vibrate(200);
      }
    } else if (m.t === "chatlog") {
      S.chat = m.log || [];
      if (S.chatOpen) markRead();
    } else if (m.t === "chat") {
      if (!m.m || S.chat.some(function (x) { return x.n === m.m.n; })) return;
      S.chat.push(m.m);
      if (S.chat.length > 80) S.chat.shift();
      if (S.chatOpen) { markRead(); appendMsg(m.m); return; }
    } else if (m.t === "rtc") {
      onRtc(m);
      return;
    } else if (m.t === "err") {
      if (m.fatal) clearSession();
      flash(m.msg);
      return;
    } else if (m.t === "kicked") {
      clearSession(); flash("You were removed from the game.");
      return;
    }
    render();
  }

  /* ---------- views ---------- */
  function nm(st, id) {
    for (var i = 0; i < st.players.length; i++)
      if (st.players[i].id === id) return st.players[i].name;
    return "Player";
  }

  function nameList(st, ids) {
    return ids.map(function (i) { return esc(nm(st, i)); }).join(" and ");
  }

  function joinUrl(code) { return location.origin + "/?room=" + code; }

  function qrSvg(url) {
    try {
      if (typeof qrcode !== "function") return "";
      var q = qrcode(0, "M"); q.addData(url); q.make();
      var n = q.getModuleCount(), m = 4, d = "";
      for (var r = 0; r < n; r++)
        for (var c = 0; c < n; c++)
          if (q.isDark(r, c)) d += "M" + (c + m) + " " + (r + m) + "h1v1h-1z";
      var s = n + m * 2;
      return '<svg viewBox="0 0 ' + s + " " + s + '" role="img" aria-label="QR code to join this game" shape-rendering="crispEdges"><rect width="' + s + '" height="' + s + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    } catch (e) { return ""; }
  }

  function homeView() {
    var ios = isIOS && !isStandalone;
    return '<div class="stack">' +
      "<h1>Find the odd word.</h1>" +
      '<p class="lede">Everyone gets the same secret word except the odd ones out, who share a close cousin of it. Give clues, then vote.</p>' +
      '<div class="tight"><h2>Your name</h2><input type="text" id="nm" maxlength="16" value="' + esc(S.name) + '" placeholder="Nickname" autocomplete="off" aria-label="Your name"></div>' +
      '<button class="btn" data-act="create">Create a game</button>' +
      '<div class="tight"><h2>Or join a friend</h2><div class="row"><input type="text" id="code" maxlength="4" value="' + esc(S.joinCode) + '" placeholder="CODE" autocomplete="off" autocapitalize="characters" aria-label="Game code"><button class="btn inline" data-act="join">Join</button></div></div>' +
      (S.installEvt ? '<button class="btn ghost" data-act="install">Install the app</button>' : "") +
      (ios ? '<p class="small">To install on iPhone: tap the Share button, then Add to Home Screen.</p>' : "") +
      "</div>";
  }

  function whoChips(st) {
    return '<div class="who">' + st.players.map(function (p) {
      var kick = st.host && p.id !== st.me && !p.on
        ? '<button class="x" data-act="kick" data-id="' + esc(p.id) + '" aria-label="Remove ' + esc(p.name) + '">×</button>'
        : "";
      return '<span class="' + (p.on ? "" : "off") + (p.v ? " vc" : "") + '">' +
        esc(p.name) + (p.id === st.hostId ? ' <i class="hb">host</i>' : "") + kick + "</span>";
    }).join("") + "</div>";
  }

  function chip(act, v, label, on) {
    return '<button class="chip" data-act="' + act + '" data-v="' + esc(v) + '" aria-pressed="' + on + '">' + esc(label) + "</button>";
  }

  function settingsView(st) {
    var c = st.cfg;
    return '<div class="tight"><h2>How you are playing</h2><div class="chips">' +
      chip("mode", "f2f", "Face to face", c.mode === "f2f") +
      chip("mode", "online", "Online", c.mode === "online") + "</div>" +
      '<p class="small">' + (c.mode === "online"
        ? "Clues are typed or spoken into the mic and shown on every screen. Keep a voice call going to talk during the vote."
        : "Everyone is in the same room. Clues are said out loud.") + "</p></div>" +
      '<div class="tight"><h2>Word packs</h2><div class="chips">' +
      st.cats.map(function (x) { return chip("cat", x[0], x[1], c.cats.indexOf(x[0]) >= 0); }).join("") +
      '</div><p class="small">Tap one or several to combine them. Mixed uses every pack.</p></div>' +
      '<div class="tight"><h2>Odd ones out</h2><div class="chips">' +
      chip("imps", "1", "1", c.imps === 1) + chip("imps", "2", "2", c.imps === 2) +
      '</div><p class="small">With 2, both share the same odd word. Needs at least 5 players, otherwise 1 is used.</p></div>' +
      '<div class="tight"><h2>Clue rounds</h2><div class="chips">' +
      [1, 2, 3].map(function (r) { return chip("rounds", String(r), String(r), c.rounds === r); }).join("") + "</div></div>";
  }

  function lobbyView(st) {
    var url = joinUrl(st.code), svg = qrSvg(url);
    var on = st.players.filter(function (p) { return p.on; }).length;
    var host = nm(st, st.hostId);
    return '<div class="stack">' +
      "<h2>Game code</h2>" +
      '<div class="codebig">' + esc(st.code) + "</div>" +
      (svg ? '<div class="qrbox">' + svg + "</div>" : "") +
      '<p class="link">' + esc(url) + "</p>" +
      '<div class="row"><button class="btn ghost" data-act="share">Share invite</button><button class="btn ghost" data-act="copy">' + (S.copied ? "Link copied" : "Copy link") + "</button></div>" +
      '<div class="tight"><h2>Players (' + st.players.length + ")</h2>" + whoChips(st) + "</div>" +
      (st.host
        ? '<div class="panel host stack"><h2 style="color:var(--accent)">Host controls</h2>' + settingsView(st) +
          '<button class="btn" data-act="deal" ' + (on < 4 ? "disabled" : "") + ">" +
          (on < 4 ? "Need " + (4 - on) + " more player" + (4 - on > 1 ? "s" : "") : "Deal words to " + on + " players") + "</button>" +
          (st.rd ? '<button class="btn ghost" data-act="reset">Reset scores</button>' : "") + "</div>"
        : '<p class="small">Waiting for ' + esc(host) + " to start. " + summaryText(st) + "</p>") +
      "</div>";
  }

  function summaryText(st) {
    var c = st.cfg;
    return (c.mode === "online" ? "Online" : "Face to face") + ", " +
      c.imps + " odd one" + (c.imps > 1 ? "s" : "") + ", " +
      c.rounds + " clue round" + (c.rounds > 1 ? "s" : "") + ".";
  }

  function dealView(st) {
    var card = S.show
      ? '<div class="wordcard"><div class="label">Your word is</div><div class="word">' + esc(st.word) + "</div></div>"
      : '<div class="wordcard hidden"><div class="label">Round ' + st.rd + '</div><div class="word">Hidden</div></div>';
    return '<div class="stack"><h1>Your word</h1>' + card +
      '<p class="small">Keep your screen away from others. Remember the word, then hide it. When it is your turn, say something that fits it without saying it.</p>' +
      '<button class="btn" data-act="peek">' + (S.show ? "Hide my word" : "Tap to see my word") + "</button></div>";
  }

  function clueBoard(st) {
    if (!st.clues || !st.clues.length) return "";
    return '<div class="panel"><h2 style="margin-bottom:.4rem">Clues so far</h2><ul class="order clues">' +
      st.clues.map(function (c) {
        return "<li><span>" + esc(nm(st, c.id)) + ' <span class="small">R' + c.round + "</span></span><span>" + esc(c.text) + "</span></li>";
      }).join("") + "</ul></div>";
  }

  function micLabel() { return S.dstate === "listening" ? "Stop mic" : "Speak your clue"; }

  function cluesView(st) {
    var n = st.order.length, total = n * st.rounds;
    var round = Math.floor(st.turn / n) + 1, pos = st.turn % n;
    var spk = st.order[pos], mine = spk === st.me;
    var next = st.turn + 1 < total ? nm(st, st.order[(st.turn + 1) % n]) : null;
    var online = st.mode === "online";
    var mine_ui = "";

    if (mine && online) {
      mine_ui = '<div class="tight"><h2>Your clue</h2>' +
        '<input type="text" id="clue" maxlength="60" value="' + esc(S.draft) + '" placeholder="One word or a short phrase" autocomplete="off" aria-label="Your clue">' +
        '<div class="row">' + (SR && !S.micOff && !V.on ? '<button class="btn ghost" data-act="mic" id="micbtn">' + micLabel() + "</button>" : "") +
        '<button class="btn" data-act="send">Send clue</button></div>' +
        (V.on ? '<p class="small">You are on voice chat, so type your clue. Everyone can also hear you.</p>' : SR && !S.micOff ? "" : '<p class="small">The mic is not available here. Type your clue.</p>') + "</div>";
    } else if (mine) {
      mine_ui = '<button class="btn" data-act="done">I have given my clue</button>';
    }

    var peek = S.show
      ? '<div class="panel"><div class="small">Your word</div><div class="speaker">' + esc(st.word) + "</div></div>"
      : "";

    return '<div class="stack"><h2>Round ' + round + " of " + st.rounds + "</h2>" +
      '<div class="panel stack"><div class="small">' + (mine ? (online ? "Your turn. Type or speak your clue." : "Your turn. Say one word or a short phrase out loud.") : "Now speaking") + "</div>" +
      '<div class="speaker">' + esc(nm(st, spk)) + "</div>" +
      '<div class="small">' + (next ? "Next up: " + esc(next) : "Last clue of the game") + "</div></div>" +
      mine_ui +
      '<ul class="order">' + st.order.map(function (id, i) {
        return '<li class="' + (i === pos ? "now" : i < pos ? "past" : "") + '"><span>' + esc(nm(st, id)) + "</span><span>" + (i + 1) + "</span></li>";
      }).join("") + "</ul>" +
      (online ? clueBoard(st) : "") + peek +
      '<button class="btn ghost" data-act="peek">' + (S.show ? "Hide my word" : "Remind me of my word") + "</button></div>";
  }

  function voteView(st) {
    var locked = st.voted.indexOf(st.me) >= 0;
    var sel = locked ? st.myVotes : S.pick;
    var others = st.order.filter(function (id) { return id !== st.me; });

    return '<div class="stack"><h1>' + (st.k > 1 ? "Who are the odd ones?" : "Who is the odd one?") + "</h1>" +
      '<p class="lede">' + (st.k > 1 ? "There are " + st.k + " odd ones among you. Pick " + st.k + " players." : "Pick the player you think has the odd word.") + "</p>" +
      (st.mode === "online" ? clueBoard(st) : "") +
      '<div class="grid">' + others.map(function (id) {
        return '<button class="pick" data-act="vote" data-id="' + esc(id) + '" aria-pressed="' + (sel.indexOf(id) >= 0) + '" ' + (locked ? "disabled" : "") + ">" + esc(nm(st, id)) + "</button>";
      }).join("") + "</div>" +
      '<button class="btn" data-act="lock" ' + (locked || S.pick.length !== st.k ? "disabled" : "") + ">" + (locked ? "Vote locked" : "Lock in my vote") + "</button>" +
      '<p class="small">' + st.voted.length + " of " + st.order.length + " players have locked in.</p></div>";
  }

  function boardView(st, imps) {
    var rows = st.players.slice().sort(function (a, b) { return b.score - a.score; });
    return '<div class="panel"><h2 style="margin-bottom:.4rem">Scores</h2>' + rows.map(function (r) {
      return '<div class="score"><span>' + esc(r.name) + (imps.indexOf(r.id) >= 0 ? '<span class="tag">Odd one</span>' : "") + "</span><b>" + r.score + "</b></div>";
    }).join("") + "</div>";
  }

  function resultView(st) {
    var r = st.result, imps = r.imps, plural = imps.length > 1;
    var imp = nameList(st, imps), voted = nameList(st, r.acc);
    var head, sub;

    if (r.oc === "ask") {
      return '<div class="stack"><h1><span class="win">Caught.</span> ' + imp + (plural ? " were the odd ones" : " was the odd one") + ".</h1>" +
        '<p class="lede">' + (plural ? "Either of them gets" : imp + " gets") + " one shot to steal the win. Say what you think the group's word is, out loud, and the host will mark it.</p></div>";
    }

    if (r.oc === "group") {
      head = '<span class="win">The group wins.</span>';
      sub = imp + (plural ? " were" : " was") + " caught and could not guess the word. Each other player scores 1.";
    } else if (r.oc === "steal") {
      head = '<span class="lose">' + (plural ? "The odd ones steal it." : imp + " steals it.") + "</span>";
      sub = imp + (plural ? " were" : " was") + " caught but guessed the group word. " + (plural ? "Each scores" : imp + " scores") + " 2.";
    } else {
      head = '<span class="lose">' + imp + " got away.</span>";
      sub = "The group voted for " + voted + " and did not catch " + (plural ? "both odd ones" : "the odd one") + ". " + (plural ? "Each scores" : imp + " scores") + " 3.";
    }

    var votes = st.order.map(function (id) { return [nm(st, id), r.tally[id] || 0]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .map(function (x) { return esc(x[0]) + " " + x[1]; }).join(", ");

    return '<div class="stack"><h1>' + head + '</h1><p class="lede">' + sub + "</p>" +
      '<div class="pair"><div class="panel"><div class="small">Group word</div><div class="word">' + esc(r.civ) + '</div></div>' +
      '<div class="panel"><div class="small">Odd word</div><div class="word">' + esc(r.imp) + "</div></div></div>" +
      (st.mode === "online" ? clueBoard(st) : "") +
      '<p class="small">Votes: ' + votes + "</p>" + boardView(st, imps) + "</div>";
  }

  function waitingView(st) {
    return '<div class="stack"><h1>Round ' + st.rd + " is running.</h1>" +
      '<p class="lede">You will be dealt in at the start of the next round. Stay on this screen.</p>' +
      '<div class="tight"><h2>Players</h2>' + whoChips(st) + "</div></div>";
  }

  function hostPanel(st) {
    var body = "";

    if (st.phase === "deal") {
      body = "<h2>Words dealt</h2>" +
        '<div class="who">' + st.order.map(function (id) {
          return '<span class="' + (st.seen.indexOf(id) >= 0 ? "ok" : "") + '">' + esc(nm(st, id)) + "</span>";
        }).join("") + "</div>" +
        '<p class="small">' + st.seen.length + " of " + st.order.length + " have looked at their word.</p>" +
        '<button class="btn" data-act="clues">Start clues</button>' +
        '<button class="btn ghost" data-act="deal">Re-deal a new word</button>';
    } else if (st.phase === "clues") {
      body = "<h2>Clues</h2>" +
        '<p class="small">' + (st.mode === "online" ? "Moves on when the speaker sends a clue." : "Moves on when the speaker taps their button.") + " Use these if someone is stuck or has dropped out.</p>" +
        '<button class="btn" data-act="skip">Skip to next speaker</button>' +
        '<button class="btn ghost" data-act="tovote">Go to vote now</button>';
    } else if (st.phase === "vote") {
      body = "<h2>Votes</h2>" +
        '<p class="small">The result shows by itself when everyone has locked in. Ties are broken at random.</p>' +
        '<button class="btn" data-act="reveal">Reveal result now</button>';
    } else if (st.phase === "result") {
      if (st.result.oc === "ask") {
        body = "<h2>Steal attempt</h2>" +
          '<button class="btn" data-act="gok">' + (st.result.imps.length > 1 ? "An odd one" : "The odd one") + " guessed the group word</button>" +
          '<button class="btn ghost" data-act="gno">They missed it</button>';
      } else {
        body = "<h2>Next</h2>" +
          '<button class="btn" data-act="deal">Next round with a new word</button>' +
          '<button class="btn ghost" data-act="lobby">Back to lobby</button>' +
          '<button class="btn ghost" data-act="reset">Reset scores and go to lobby</button>';
      }
    }

    return body ? '<div class="panel host stack"><h2 style="color:var(--accent)">Host controls</h2>' + body + "</div>" : "";
  }

  function gameView(st) {
    if (st.phase === "lobby") return lobbyView(st);

    var me = null;
    for (var i = 0; i < st.players.length; i++)
      if (st.players[i].id === st.me) me = st.players[i];

    var inRound = me && me.inRound;
    var main;

    if (st.phase === "result") main = resultView(st);
    else if (!inRound) main = waitingView(st);
    else if (st.phase === "deal") main = dealView(st);
    else if (st.phase === "clues") main = cluesView(st);
    else main = voteView(st);

    return main + (st.host ? '<div style="height:.25rem"></div>' + hostPanel(st) : "");
  }

  function topHtml(st) {
    var un = unreadCount();
    if (!st) return '<div class="top"><div class="brand">Odd Word Out</div></div>';

    return '<div class="top"><span class="pill">' + esc(st.code) + '</span>' +
      '<div class="right"><button class="leave" data-act="chat">Chat' +
      (un ? '<span class="badge">' + (un > 9 ? "9+" : un) + "</span>" : "") +
      '</button><button class="leave ' + (S.leaveArm ? "armed" : "") + '" data-act="leave">' +
      (S.leaveArm ? "Tap again to leave" : "Leave") + "</button></div></div>";
  }

  /* ---------- rendering ---------- */
  var dirty = false;

  function render() {
    var ae = document.activeElement;
    if (ae && (ae.id === "nm" || ae.id === "code" || ae.id === "clue" || ae.id === "chatin")) {
      dirty = true;
      return;
    }
    dirty = false;
    draw();
  }

  function draw() {
    var st = S.st;
    var banner = !S.conn ? '<div class="banner" role="status">Reconnecting to the game...</div>' : "";
    var main = st ? gameView(st) : homeView();

    var box = document.getElementById("msgs");
    var atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    var keep = box ? box.scrollTop : 0;

    $app.innerHTML = topHtml(st) + banner + (st ? voiceBar(st) : "") +
      '<div class="view">' + main + "</div>" +
      (st && S.chatOpen ? chatSheet() : "") +
      (S.toast ? '<div class="toast" role="status">' + esc(S.toast) + "</div>" : "");

    document.body.style.overflow = st && S.chatOpen ? "hidden" : "";
    box = document.getElementById("msgs");
    if (box) box.scrollTop = atBottom ? box.scrollHeight : keep;

    if (st) keepAwake();
  }

  document.addEventListener("focusout", function () {
    if (dirty) setTimeout(render, 80);
  });

  /* ---------- actions ---------- */
  function sendCfg(patch) {
    var c = Object.assign({}, S.st.cfg, patch);
    send({ t: "cfg", cats: c.cats, imps: c.imps, rounds: c.rounds, mode: c.mode });
  }

  function toggleCat(v) {
    var c = S.st.cfg.cats.filter(function (x) { return x !== "mixed"; });
    if (v === "mixed") c = ["mixed"];
    else {
      var i = c.indexOf(v);
      if (i >= 0) c.splice(i, 1); else c.push(v);
      if (!c.length) c = ["mixed"];
    }
    sendCfg({ cats: c });
  }

  function stopMic() {
    if (rec) { try { rec.stop(); } catch (e) {} }
  }

  var rec = null;

  function setMicUI() {
    var b = document.getElementById("micbtn");
    if (b) b.textContent = micLabel();
  }

  function toggleMic() {
    if (!SR) return;
    if (S.dstate === "listening") { stopMic(); return; }

    var el = document.getElementById("clue");
    S.dBase = el ? el.value.trim() : "";

    rec = new SR();
    rec.lang = "en-IN"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;

    rec.onstart = function () { S.dstate = "listening"; setMicUI(); };

    rec.onresult = function (e) {
      var text = "";
      for (var i = 0; i < e.results.length; i++)
        text += e.results[i][0].transcript + " ";

      var box = document.getElementById("clue");
      if (box) {
        box.value = (S.dBase + " " + text).trim().slice(0, 60);
        S.draft = box.value;
      }
    };

    rec.onerror = function (e) {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        S.micOff = true;
        flash("Mic permission was denied. Type your clue instead.");
      }
    };

    rec.onend = function () { S.dstate = "idle"; rec = null; setMicUI(); };
    try { rec.start(); } catch (e) { S.dstate = "idle"; }
  }

  function act(a, d) {
    var st = S.st;
    d = d || {};

    switch (a) {
      case "create": {
        var n1 = S.name.trim();
        if (!n1) return flash("Type your name first.");
        LS.set("oowl-name", n1);
        send({ t: "create", name: n1 });
        break;
      }

      case "join": {
        var n2 = S.name.trim();
        if (!n2) return flash("Type your name first.");
        if (S.joinCode.length !== 4) return flash("Enter the 4 letter game code.");
        LS.set("oowl-name", n2);
        S.code = null; S.token = null;
        send({ t: "join", code: S.joinCode, name: n2 });
        break;
      }

      case "install":
        if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; render(); }
        break;

      case "leave":
        if (!S.leaveArm) {
          S.leaveArm = true; render();
          setTimeout(function () { S.leaveArm = false; render(); }, 3000);
        } else {
          send({ t: "leave" }, true); clearSession(); S.leaveArm = false; render();
        }
        break;

      case "share": {
        var url = joinUrl(st.code);
        if (navigator.share)
          navigator.share({ title: "Odd Word Out", text: "Join my game. Code " + st.code, url: url }).catch(function () {});
        else act("copy");
        break;
      }

      case "copy":
        try {
          navigator.clipboard.writeText(joinUrl(st.code)).then(function () {
            S.copied = true; render();
            setTimeout(function () { S.copied = false; render(); }, 1800);
          }, function () { flash("Copy failed. Press and hold the link to copy it."); });
        } catch (e) { flash("Copy failed. Press and hold the link to copy it."); }
        break;

      case "mode": sendCfg({ mode: d.v }); break;
      case "cat": toggleCat(d.v); break;
      case "imps": sendCfg({ imps: +d.v }); break;
      case "rounds": sendCfg({ rounds: +d.v }); break;
      case "kick": send({ t: "kick", id: d.id }); break;

      case "deal": case "clues": case "skip": case "tovote":
      case "reveal": case "lobby": case "reset": case "done":
        send({ t: a }); break;

      case "gok": send({ t: "guess", ok: true }); break;
      case "gno": send({ t: "guess", ok: false }); break;

      case "peek":
        S.show = !S.show;
        if (S.show && st && st.phase === "deal" && st.seen.indexOf(st.me) < 0)
          send({ t: "seen" });
        render();
        break;

      case "mic": toggleMic(); break;

      case "chat": S.chatOpen = true; markRead(); render(); break;
      case "chatclose": S.chatOpen = false; markRead(); render(); break;

      case "chatsend": {
        var ci = document.getElementById("chatin");
        var ct = (ci ? ci.value : S.chatDraft).trim();
        if (!ct) return;
        send({ t: "chat", text: ct });
        if (ci) ci.value = "";
        S.chatDraft = "";
        break;
      }

      case "vjoin": joinVoice(); break;
      case "vmute": toggleMute(); break;
      case "vleave": leaveVoice(true); break;

      case "send": {
        var el = document.getElementById("clue");
        var txt = (el ? el.value : S.draft).trim();
        if (!txt) return flash("Type or speak a clue first.");
        stopMic();
        if (el) el.blur();
        send({ t: "clue", text: txt });
        break;
      }

      case "vote": {
        if (!st) break;
        var at = S.pick.indexOf(d.id);
        if (at >= 0) S.pick.splice(at, 1);
        else { if (S.pick.length >= st.k) S.pick.shift(); S.pick.push(d.id); }
        render();
        break;
      }

      case "lock":
        if (st && S.pick.length === st.k) send({ t: "vote", picks: S.pick });
        break;
    }
  }

  $app.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    act(b.dataset.act, b.dataset);
  });

  // Tapping Send must not close the keyboard.
  $app.addEventListener("mousedown", function (e) {
    if (e.target.closest("[data-act=chatsend]")) e.preventDefault();
  });

  $app.addEventListener("input", function (e) {
    var id = e.target.id;
    if (id === "nm") S.name = e.target.value;
    else if (id === "code") {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
      S.joinCode = e.target.value;
    } else if (id === "clue") S.draft = e.target.value;
    else if (id === "chatin") S.chatDraft = e.target.value;
  });

  $app.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var id = e.target.id;
    if (id === "code") { e.preventDefault(); e.target.blur(); act("join"); }
    else if (id === "clue") { e.preventDefault(); act("send"); }
    else if (id === "chatin") { e.preventDefault(); act("chatsend"); }
    else if (id === "nm") { e.preventDefault(); e.target.blur(); }
  });

  /* ---------- chat ---------- */
  function meId() { return S.st ? S.st.me : null; }

  function unreadCount() {
    var c = 0, me = meId();
    for (var i = 0; i < S.chat.length; i++)
      if (S.chat[i].n > S.readN && S.chat[i].id !== me) c++;
    return c;
  }

  function markRead() {
    if (S.chat.length) S.readN = S.chat[S.chat.length - 1].n;
  }

  function chatMsgHtml(m) {
    var mine = m.id === meId();
    return '<div class="msg' + (mine ? " mine" : "") + '"><div class="small">' +
      (mine ? "You" : esc(m.name)) + '</div><div class="bub">' + esc(m.text) + "</div></div>";
  }

  function chatSheet() {
    return '<div class="sheet" role="dialog" aria-label="Chat"><div class="sheethead"><h2>Chat</h2><button class="leave" data-act="chatclose">Close</button></div>' +
      '<div class="msgs" id="msgs">' + (S.chat.length ? S.chat.map(chatMsgHtml).join("") : '<p class="small" id="nomsg">No messages yet. Say hi.</p>') + "</div>" +
      '<div class="row chatrow"><input type="text" id="chatin" maxlength="200" value="' + esc(S.chatDraft) + '" placeholder="Message everyone" autocomplete="off" aria-label="Message"><button class="btn inline" data-act="chatsend">Send</button></div></div>';
  }

  function appendMsg(m) {
    var box = document.getElementById("msgs");
    if (!box) { render(); return; }
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 60 || m.id === meId();
    var ph = document.getElementById("nomsg");
    if (ph) ph.remove();
    box.insertAdjacentHTML("beforeend", chatMsgHtml(m));
    if (near) box.scrollTop = box.scrollHeight;
  }

  /* ---------- voice chat (phone to phone, audio never touches the server) ---------- */
  function voiceSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
  }

  function voiceBar(st) {
    if (st.cfg.mode !== "online" && !V.on) return "";
    if (!voiceSupported())
      return '<div class="voicebar"><span class="small">Voice chat needs a newer browser, and the https link.</span></div>';

    var others = st.players.filter(function (p) { return p.v && p.id !== st.me; }).length;

    if (!V.on) {
      return '<div class="voicebar"><div><b>Voice chat</b><div class="small">' + (others ? others + " in voice now. " : "Talk live. ") + 'Use headphones.</div></div>' +
        '<button class="btn inline" data-act="vjoin" ' + (V.starting ? "disabled" : "") + ">" + (V.starting ? "Starting..." : "Join voice") + "</button></div>";
    }

    var conn = 0;
    Object.keys(V.pcs).forEach(function (id) { if (V.pcs[id].state === "connected") conn++; });

    return '<div class="voicebar on"><div><b>' + (V.muted ? "You are muted" : "Your mic is on") + '</b><div class="small">Hearing ' + conn + " of " + others + '</div></div>' +
      '<button class="btn ghost inline" data-act="vmute">' + (V.muted ? "Unmute" : "Mute") + '</button><button class="btn ghost inline" data-act="vleave">Leave</button></div>';
  }

  function joinVoice() {
    if (V.on || V.starting) return;
    if (!voiceSupported()) return flash("Voice chat needs the https link and a newer browser.");

    V.starting = true; render();

    Promise.all([
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
      fetch("/ice").then(function (r) { return r.json(); }).then(function (j) { return j.ice; }).catch(function () { return [{ urls: "stun:stun.l.google.com:19302" }]; }),
    ]).then(function (r) {
      V.stream = r[0]; V.ice = r[1]; V.on = true; V.muted = false; V.starting = false;
      send({ t: "vjoin" }, true); render();
    }).catch(function (e) {
      V.starting = false; render();
      flash(e && e.name === "NotAllowedError" ? "Mic permission was blocked. Allow the mic for this site to talk." : "Could not start the mic.");
    });
  }

  function closePc(id) {
    var e = V.pcs[id];
    if (!e) return;
    delete V.pcs[id];
    try { e.pc.close(); } catch (x) {}
    if (e.audio) { try { e.audio.srcObject = null; } catch (x) {} e.audio.remove(); }
  }

  function teardownVoice() {
    Object.keys(V.pcs).forEach(closePc);
    if (V.stream) V.stream.getTracks().forEach(function (t) { t.stop(); });
    V.stream = null; V.on = false; V.muted = false; V.starting = false;
  }

  function leaveVoice(notify) {
    if (notify) send({ t: "vleave" }, true);
    teardownVoice(); render();
  }

  function toggleMute() {
    if (!V.stream) return;
    V.muted = !V.muted;
    V.stream.getAudioTracks().forEach(function (t) { t.enabled = !V.muted; });
    render();
  }

  function mkPc(id, v, myV) {
    var pc = new RTCPeerConnection({ iceServers: V.ice });
    var e = { pc: pc, v: v, myV: myV, q: [], audio: null, state: "connecting", warned: false };
    V.pcs[id] = e;

    V.stream.getTracks().forEach(function (t) { pc.addTrack(t, V.stream); });

    pc.onicecandidate = function (ev) {
      if (ev.candidate) send({ t: "rtc", to: id, d: { c: ev.candidate.toJSON() } }, true);
    };

    pc.ontrack = function (ev) {
      var a = e.audio;
      if (!a) {
        a = document.createElement("audio");
        a.autoplay = true; a.setAttribute("playsinline", "");
        document.getElementById("vaudio").appendChild(a);
        e.audio = a;
      }
      a.srcObject = ev.streams[0];
      var pr = a.play(); if (pr && pr.catch) pr.catch(function () {});
    };

    pc.onconnectionstatechange = function () {
      e.state = pc.connectionState;
      if (e.state === "failed" && !e.warned && S.st) {
        e.warned = true;
        flash("Voice could not connect with " + nm(S.st, id) + ". Their network may block it.");
      } else render();
    };

    return e;
  }

  function flushQ(e) {
    e.q.splice(0).forEach(function (c) { e.pc.addIceCandidate(c).catch(function () {}); });
  }

  // The player who joined voice later makes the call, so two people never call each other at once.
  function syncVoice() {
    var st = S.st;
    if (!st || !V.on) return;

    var me = null, others = [];
    st.players.forEach(function (p) { if (p.id === st.me) me = p; else others.push(p); });
    if (!me) return;

    Object.keys(V.pcs).forEach(function (id) {
      var p = others.filter(function (x) { return x.id === id; })[0], e = V.pcs[id];
      if (!p || !p.v || e.v !== p.v || e.myV !== me.v) closePc(id);
    });

    if (!me.v) { send({ t: "vjoin" }, true); return; }

    others.forEach(function (p) {
      if (!p.v || V.pcs[p.id] || me.v < p.v) return;
      var e = mkPc(p.id, p.v, me.v);
      e.pc.createOffer().then(function (o) { return e.pc.setLocalDescription(o); })
        .then(function () { send({ t: "rtc", to: p.id, d: { o: e.pc.localDescription.toJSON() } }, true); })
        .catch(function () { closePc(p.id); });
    });
  }

  function onRtc(m) {
    var st = S.st;
    if (!V.on || !st || typeof m.from !== "string") return;

    var d = m.d || {}, from = m.from, fp = null, me = null;
    st.players.forEach(function (p) { if (p.id === from) fp = p; if (p.id === st.me) me = p; });
    if (!fp || !fp.v || !me || !me.v) return;

    var e;

    if (d.o) {
      closePc(from);
      e = mkPc(from, fp.v, me.v);
      e.pc.setRemoteDescription(d.o).then(function () {
        flushQ(e); return e.pc.createAnswer();
      }).then(function (a) { return e.pc.setLocalDescription(a); })
        .then(function () { send({ t: "rtc", to: from, d: { a: e.pc.localDescription.toJSON() } }, true); })
        .catch(function () { closePc(from); });
    } else if (d.a) {
      e = V.pcs[from];
      if (e) e.pc.setRemoteDescription(d.a).then(function () { flushQ(e); }).catch(function () {});
    } else if (d.c) {
      e = V.pcs[from];
      if (!e) return;
      if (e.pc.remoteDescription) e.pc.addIceCandidate(d.c).catch(function () {});
      else e.q.push(d.c);
    }
  }

  /* ---------- phone niceties ---------- */
  var wake = null;

  function keepAwake() {
    try {
      if (!wake && "wakeLock" in navigator && document.visibilityState === "visible") {
        navigator.wakeLock.request("screen").then(function (l) {
          wake = l; l.addEventListener("release", function () { wake = null; });
        }, function () {});
      }
    } catch (e) {}
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    keepAwake();
    if (!S.ws || S.ws.readyState > 1) connect();
  });

  window.addEventListener("online", function () {
    if (!S.ws || S.ws.readyState > 1) connect();
  });

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); S.installEvt = e; render();
  });

  window.addEventListener("appinstalled", function () {
    S.installEvt = null; render();
  });

  if ("serviceWorker" in navigator)
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });

  render();
  connect();
})();
