"use strict";
/* THE SILENT DEAD – client.
 * Rendering rule: DOM nodes that contain images are created ONCE per card and then only
 * patched (see reconcile). Re-creating <img> elements on every server update is what made
 * evidence cards flicker / "disappear" before. */

const $ = (id) => document.getElementById(id);
const PLACEHOLDER = "assets/evidence/placeholder.svg";
const SESSION_KEY = "silentDeadSession";
const NAME_KEY = "silentDeadName";

let socket = null;
let state = null;
let currentScreen = null;
let lastPhaseKey = null;
let resumePromise = Promise.resolve();
let seenEvidence = null; // Set of evidence ids the detective has already been told about
let localPick = null; // optimistic suspect selection (detective)
let busy = false;
const selectedCards = new Set();
let selectedTarget = null;
let soundOn = false, audioCtx = null, osc = null, gain = null;

/* ---------------- tiny helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const asset = (p) => (typeof p === "string" && p ? (p.startsWith("http") ? p : p.replace(/^\//, "")) : PLACEHOLDER);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const safeLS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

function setHTML(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } }
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function toggle(el, cls, on) { if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on); }

/** Keep `container`'s keyed children in sync with `items` without recreating existing nodes. */
function reconcile(container, items, keyFn, create, update) {
  const existing = new Map();
  for (const ch of Array.from(container.children)) {
    if (ch.dataset.key !== undefined) existing.set(ch.dataset.key, ch); else ch.remove();
  }
  let prev = null;
  for (const item of items) {
    const k = String(keyFn(item));
    let el = existing.get(k);
    if (el) existing.delete(k); else { el = create(item); el.dataset.key = k; }
    update(el, item);
    const expected = prev ? prev.nextSibling : container.firstChild;
    if (el !== expected) container.insertBefore(el, expected);
    prev = el;
  }
  existing.forEach((el) => el.remove());
}

/** <img> that retries on a transient network error and only then falls back to the placeholder. */
function makeImg(src, alt) {
  const img = new Image();
  img.decoding = "async";
  img.draggable = false;
  img.alt = alt || "";
  img.classList.add("img-fade");
  img.onload = () => img.classList.add("loaded");
  let tries = 0;
  const original = asset(src);
  img.onerror = () => {
    if (tries++ < 2) setTimeout(() => { img.src = `${original}${original.includes("?") ? "&" : "?"}r=${tries}`; }, 700 * tries);
    else { img.onerror = null; img.src = PLACEHOLDER; img.classList.add("loaded"); }
  };
  img.src = original;
  return img;
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.classList.add("hidden"), 250); }, 3200);
}

/* ---------------- modal + lightbox ---------------- */
let modalResolve = null;
function confirmDialog({ title, text, yes = "YES", no = "NO" }) {
  return new Promise((resolve) => {
    if (modalResolve) modalResolve(false);
    modalResolve = resolve;
    $("modalTitle").textContent = title;
    $("modalText").textContent = text;
    $("modalYes").firstChild.textContent = yes;
    $("modalNo").textContent = no;
    $("modal").classList.remove("hidden");
    $("modalYes").focus();
  });
}
function closeModal(result) {
  $("modal").classList.add("hidden");
  const r = modalResolve; modalResolve = null;
  if (r) r(result);
}
function openLightbox(card) {
  $("lightboxImg").src = asset(card.image);
  $("lightboxImg").alt = card.name;
  setText($("lightboxTitle"), card.name);
  setText($("lightboxDesc"), card.description || "");
  $("lightbox").classList.remove("hidden");
}
const closeLightbox = () => $("lightbox").classList.add("hidden");

/* ---------------- networking ---------------- */
function setConnection(online) {
  const el = $("connection");
  el.classList.toggle("online", online);
  setText(el.lastElementChild, online ? "CONNECTED" : "RECONNECTING");
}
const loadSession = () => { try { return JSON.parse(safeLS.get(SESSION_KEY) || "null"); } catch { return null; } };
const saveSession = (x) => safeLS.set(SESSION_KEY, JSON.stringify({ code: x.code, playerId: x.playerId, token: x.token }));

function emit(event, payload = {}) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) { toast("Not connected to the server yet."); resolve({ ok: false }); return; }
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; toast("The server did not answer. Please try again."); resolve({ ok: false }); } }, 10000);
    socket.emit(event, payload, (res) => {
      if (done) return; done = true; clearTimeout(timer);
      if (!res || !res.ok) toast((res && res.message) || "Something went wrong.");
      resolve(res || { ok: false });
    });
  });
}

/** Run an action once at a time and keep the buttons from being double-clicked. */
async function guarded(fn) {
  if (busy) return;
  busy = true; document.body.classList.add("is-busy");
  try { return await fn(); } finally { busy = false; document.body.classList.remove("is-busy"); }
}

function connect() {
  if (socket) return;
  socket = io({ transports: ["websocket", "polling"], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelayMax: 4000 });
  socket.on("connect", () => {
    setConnection(true);
    const sess = loadSession(); // always read the CURRENT session, never a stale captured one
    if (!sess) return;
    resumePromise = emit("room:reconnect", sess).then((res) => {
      if (res.ok) { applyState(res.state); return; }
      safeLS.del(SESSION_KEY);
      if (state) { state = null; resetLocal(); showScreen("homeScreen"); toast("That room is no longer available."); }
    });
  });
  socket.on("disconnect", () => setConnection(false));
  socket.on("game:state", (s) => applyState(s));
  socket.on("room:removed", () => {
    safeLS.del(SESSION_KEY); state = null; resetLocal(); showScreen("homeScreen"); toast("You have left this room.");
  });
}
async function ready() {
  connect();
  if (!socket.connected) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error("Could not reach the game server. Please try again.")); }, 15000);
      const ok = () => { cleanup(); resolve(); };
      function cleanup() { clearTimeout(t); socket.off("connect", ok); }
      socket.on("connect", ok);
    });
  }
  await resumePromise;
}
function resetLocal() { selectedCards.clear(); selectedTarget = null; localPick = null; seenEvidence = null; lastPhaseKey = null; }

async function enterRoom(event, payload) {
  try {
    await ready();
    const res = await emit(event, payload);
    if (res.ok) { saveSession(res); resetLocal(); applyState(res.state); }
  } catch (e) { toast(e.message); }
}
function nameOrToast() {
  const name = $("playerName").value.trim();
  if (!name) { toast("Enter your name first."); $("playerName").focus(); return null; }
  safeLS.set(NAME_KEY, name);
  return name;
}
const createRoom = () => guarded(async () => { const name = nameOrToast(); if (name) await enterRoom("room:create", { name }); });
const joinRoom = () => guarded(async () => {
  const name = nameOrToast(); if (!name) return;
  const code = $("roomCode").value.trim();
  if (code.length < 5) { toast("Enter the 5-letter room code."); $("roomCode").focus(); return; }
  await enterRoom("room:join", { name, code });
});

/* ---------------- state -> screen ---------------- */
function applyState(s) {
  if (!s) return;
  localPick = null;
  if (s.you && s.you.role === "detective") {
    const ids = (s.myEvidence || []).map((c) => c.id);
    if (seenEvidence === null) seenEvidence = new Set(ids);
    else {
      const fresh = ids.filter((id) => !seenEvidence.has(id));
      if (fresh.length) toast(`The Ghost sent you ${plural(fresh.length, "new clue")}.`);
      ids.forEach((id) => seenEvidence.add(id));
    }
  }
  state = s;
  render();
}

function showScreen(id) {
  if (currentScreen === id) return;
  currentScreen = id;
  for (const x of ["homeScreen", "lobbyScreen", "gameScreen", "endScreen"]) {
    const el = $(x);
    el.classList.toggle("hidden", x !== id);
    if (x === id) { el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter"); }
  }
  window.scrollTo({ top: 0 });
}
const isAdmin = () => !!(state && state.you && state.you.isAdmin);

function render() {
  if (!state) return;
  if (state.phase === "lobby") { showScreen("lobbyScreen"); renderLobby(); }
  else if (state.phase === "finished") { showScreen("endScreen"); renderEnd(); }
  else { showScreen("gameScreen"); renderGame(); }
}

/* ---------------- lobby ---------------- */
function renderLobby() {
  setText($("lobbyCode"), state.code);
  setText($("playerCount"), `${state.players.length} / 6`);
  setHTML($("playerList"), state.players.map((p) => `
    <div class="player-row">
      <div class="player-avatar" style="color:${p.color}">${esc(p.name.slice(0, 1).toUpperCase())}</div>
      <div class="player-name">${esc(p.name)}${p.id === state.you.id ? ' <small class="you">YOU</small>' : ""}${p.id === state.ghostId ? ' <small class="ghost-pill">GHOST</small>' : ""}</div>
      <span class="player-meta">${p.id === state.adminId ? "HOST" : "GUEST"}</span>
      <span class="online-state ${p.connected ? "on" : "off"}">${p.connected ? "● ONLINE" : "○ AWAY"}</span>
      ${isAdmin() && p.id !== state.adminId ? `<button class="text-btn" data-kick="${p.id}">REMOVE</button>` : ""}
    </div>`).join(""));
  const ghostValue = state.randomGhost ? "random" : state.ghostId || "";
  setHTML($("ghostSelect"), `<option value="">Choose the Ghost…</option><option value="random">🎲 Random player</option>` +
    state.players.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join(""));
  if ($("ghostSelect").value !== ghostValue) $("ghostSelect").value = ghostValue;
  if ($("shuffleLimit").value !== String(state.settings.shuffleLimit)) $("shuffleLimit").value = String(state.settings.shuffleLimit);
  $("ghostSelect").disabled = !isAdmin();
  $("shuffleLimit").disabled = !isAdmin();
  $("roundOptions").querySelectorAll("button").forEach((b) => {
    toggle(b, "selected", Number(b.dataset.round) === state.settings.rounds);
    b.disabled = !isAdmin();
  });
  const ghostOk = state.randomGhost || state.players.some((p) => p.id === state.ghostId);
  const everyoneOnline = state.players.every((p) => p.connected);
  $("startGame").disabled = !isAdmin() || state.players.length < 2 || !ghostOk || !everyoneOnline;
  toggle($("startGame"), "hidden", !isAdmin());
  toggle($("closeRoom"), "hidden", !isAdmin());
  setText($("startHint"), !isAdmin() ? "Waiting for the host to begin the séance…"
    : state.players.length < 2 ? "Waiting for at least one more player to join."
    : !ghostOk ? "Choose who will be the Ghost."
    : !everyoneOnline ? "Waiting for every player to be online." : "");
}

/* ---------------- game ---------------- */
const PHASE_TITLES = {
  distribute: ["THE GHOST LEAVES SIGNS", "Evidence distribution"],
  select: ["THE DETECTIVES MUST CHOOSE", "Choose a face"],
  reveal: ["THE TRUTH EMERGES", "The reveal"],
};

function renderGame() {
  const me = state.you;
  const ghost = me.role === "ghost";
  const phase = state.phase;
  const myPawn = state.pawns.find((p) => p.playerId === me.id);
  const phaseKey = `${state.round}:${phase}`;
  if (lastPhaseKey && lastPhaseKey !== phaseKey) { window.scrollTo({ top: 0, behavior: "smooth" }); selectedCards.clear(); }
  lastPhaseKey = phaseKey;

  setText($("roundLabel"), `${state.round} / ${state.maxRounds}`);
  setText($("phaseEyebrow"), PHASE_TITLES[phase][0]);
  setText($("phaseTitle"), PHASE_TITLES[phase][1]);
  $("stepper").querySelectorAll("li").forEach((li, i) => {
    const order = ["distribute", "select", "reveal"];
    toggle(li, "active", li.dataset.step === phase);
    toggle(li, "done", order.indexOf(li.dataset.step) < order.indexOf(phase));
  });
  $("gameLayout").dataset.focus = phase === "distribute" ? "side" : "board";

  renderPause();
  renderGuide(ghost, me, myPawn);
  renderBoard(ghost, me, myPawn);
  renderLegend();
  renderStatus();
  renderReveal();

  toggle($("ghostPanel"), "hidden", !ghost);
  toggle($("detectivePanel"), "hidden", ghost || me.solved || me.dropped);
  toggle($("waitingPanel"), "hidden", ghost || !(me.solved || me.dropped));
  if (ghost) renderGhost(); else renderDetective(me, myPawn);
  renderDock(ghost, me, myPawn);
}

function renderPause() {
  toggle($("pauseBanner"), "hidden", !state.paused);
  if (!state.paused) return;
  setText($("pauseText"), state.pauseReason || "Waiting for a player to reconnect…");
  const absent = isAdmin() ? state.players.filter((p) => !p.connected && !p.dropped && p.role === "detective") : [];
  setHTML($("dropList"), absent.length
    ? `<span>Can't wait?</span>` + absent.map((p) => `<button class="text-btn" data-drop="${p.id}">CONTINUE WITHOUT ${esc(p.name.toUpperCase())}</button>`).join("") : "");
}

function renderGuide(ghost, me, myPawn) {
  const phase = state.phase;
  const dets = state.players.filter((p) => p.role === "detective" && !p.solved && !p.dropped);
  const locked = dets.filter((p) => p.locked).length;
  let title, text;
  if (phase === "distribute") {
    if (ghost) {
      title = "YOUR TURN · GIVE CLUES";
      text = `You hold ${state.distribution.handSize} evidence cards. Give as many as you like (even 6) to any detectives. When you are done, press <b>End giving clues</b> – or <b>Shuffle</b> to put every card you did not give back in the deck and draw ${state.distribution.handSize} new ones.`;
    } else {
      title = "WAITING FOR THE GHOST";
      text = "The Ghost is choosing which clues to send. New evidence appears in your case file. When the Ghost is finished, you choose a suspect.";
    }
  } else if (phase === "select") {
    if (ghost) { title = "THE DETECTIVES ARE GUESSING"; text = `${locked} of ${dets.length} detectives have locked in their choice. Stay silent.`; }
    else if (me.solved) { title = "YOUR CASE IS SOLVED"; text = `Watch the others investigate. ${locked} of ${dets.length} have locked in.`; }
    else if (myPawn && myPawn.locked) { title = "CHOICE LOCKED"; text = `Waiting for the others (${locked} of ${dets.length} locked in). You can still change your choice until everyone has locked in.`; }
    else { title = "YOUR TURN · CHOOSE A SUSPECT"; text = "Tap the suspect you believe the Ghost is pointing to, then press <b>Lock in my choice</b>."; }
  } else {
    title = `ROUND ${state.round} REVEAL`;
    text = "Review everyone's result. The host continues when everyone is ready.";
  }
  setHTML($("phaseGuide"), `<strong>${title}</strong><span>${text}</span>`);
}

function renderBoard(ghost, me, myPawn) {
  const phase = state.phase;
  const pick = !ghost && !me.solved && !me.dropped ? (localPick ?? (myPawn ? myPawn.position : null)) : null;
  const canPick = !ghost && !me.solved && !me.dropped && phase === "select" && !state.paused;
  const locked = !!(myPawn && myPawn.locked);
  const byId = new Map(state.players.map((p) => [p.id, p]));
  $("suspectBoard").classList.toggle("pickable", canPick && !locked);
  setText($("boardNote"), phase === "select" && !ghost && !me.solved ? "TAP A FACE TO CHOOSE" : "THEIR FACES WILL NOT CHANGE");

  reconcile($("suspectBoard"), state.board, (s) => s.id,
    (s) => {
      const el = document.createElement("div");
      el.className = "suspect-card"; el.setAttribute("role", "button"); el.tabIndex = 0; el.dataset.pos = s.position;
      el.innerHTML = `<span class="suspect-number">${String(s.position).padStart(2, "0")}</span><div class="suspect-img"></div><div class="suspect-name"></div><div class="pawn-stack"></div><span class="suspect-tag hidden"></span><span class="suspect-check">✓</span>`;
      el.querySelector(".suspect-img").appendChild(makeImg(s.image, s.name));
      setText(el.querySelector(".suspect-name"), s.name);
      return el;
    },
    (el, s) => {
      const cleared = !!s.solvedBy;
      toggle(el, "selected", pick === s.position);
      toggle(el, "locked", pick === s.position && locked);
      toggle(el, "eliminated", cleared);
      toggle(el, "inactive", !canPick || cleared || (locked && pick !== s.position));
      el.setAttribute("aria-label", `${s.name}, suspect ${s.position}`);
      const tag = el.querySelector(".suspect-tag");
      toggle(tag, "hidden", !cleared);
      if (cleared) { const by = byId.get(s.solvedBy); setText(tag, `CLEARED${by ? " · " + by.name : ""}`); tag.style.setProperty("--c", by ? by.color : "#888"); }
      const pawns = state.pawns.filter((p) => p.position === s.position && !p.solved && !p.dropped);
      reconcile(el.querySelector(".pawn-stack"), pawns, (p) => p.playerId,
        (p) => { const i = document.createElement("i"); i.className = "pawn-dot"; return i; },
        (i, p) => { i.style.background = p.color; i.title = p.name + (p.locked ? " (locked)" : ""); setText(i, p.name.slice(0, 1).toUpperCase()); toggle(i, "locked", p.locked); });
    });
}

function renderLegend() {
  setHTML($("pawnLegend"), state.players.filter((p) => p.role === "detective").map((p) =>
    `<span class="legend-item"><i class="legend-dot" style="background:${p.color}"></i>${esc(p.name)}${p.solved ? " · SOLVED" : ""}${p.dropped ? " · LEFT" : ""}</span>`).join(""));
}

function renderStatus() {
  const phase = state.phase;
  const rows = state.players.map((p) => {
    let badge, cls = "";
    if (p.role === "ghost") { badge = "THE GHOST"; cls = "ghost"; }
    else if (p.dropped) { badge = "LEFT"; }
    else if (!p.connected) { badge = "DISCONNECTED"; cls = "warn"; }
    else if (p.solved) { badge = "SOLVED"; cls = "solved"; }
    else if (phase === "select") { badge = p.locked ? "LOCKED IN" : "CHOOSING"; cls = p.locked ? "solved" : ""; }
    else if (phase === "distribute") { badge = `${plural(p.evidenceCount, "CLUE")}`; }
    else badge = "INVESTIGATING";
    return `<div class="status-row"><i class="legend-dot" style="background:${p.color}"></i><span class="status-name">${esc(p.name)}${p.id === state.you.id ? ' <small class="you">YOU</small>' : ""}</span><span class="status-badge ${cls}">${badge}</span></div>`;
  });
  setHTML($("statusList"), rows.join(""));
}

function renderReveal() {
  const el = $("revealArea");
  if (state.phase !== "reveal" || !state.reveal) { toggle(el, "hidden", true); return; }
  toggle(el, "hidden", false);
  const rv = state.reveal;
  setHTML(el, `<h3>The veil is lifted</h3>${rv.results.map((x) => `
    <div class="reveal-row ${x.correct ? "ok" : "bad"}">
      <img src="${asset(x.suspectImage)}" alt="">
      <div class="reveal-who"><b style="color:${x.color}">${esc(x.name)}</b><small>chose #${x.position} · ${esc(x.suspectName)}</small></div>
      <span class="reveal-mark">${x.correct ? "CASE SOLVED" : "NOT THIS TIME"}</span>
    </div>`).join("")}
    ${isAdmin() ? `<button id="nextRound" class="primary-btn">${rv.final ? "VIEW FINAL TESTIMONY" : "BEGIN NEXT ROUND"} <span>↗</span></button>` : `<p class="hint center">Waiting for the host to continue…</p>`}`);
}

/* ----- ghost ----- */
function evidenceCardEl(card, withZoom) {
  const el = document.createElement("div");
  el.className = "evidence-card"; el.setAttribute("role", "button"); el.tabIndex = 0;
  el.innerHTML = `<div class="card-img"></div><strong></strong><span class="card-check">✓</span>${withZoom ? '<button type="button" class="zoom-btn" aria-label="Enlarge card" title="Enlarge">⤢</button>' : ""}`;
  el.querySelector(".card-img").appendChild(makeImg(card.image, card.name));
  setText(el.querySelector("strong"), card.name);
  el.title = card.description || card.name;
  return el;
}

function renderGhost() {
  const d = state.distribution;
  const dist = state.phase === "distribute";
  const dets = state.players.filter((p) => p.role === "detective" && !p.solved && !p.dropped);
  toggle($("ghostControls"), "hidden", !dist);
  toggle($("ghostWaiting"), "hidden", dist);
  if (!dist) {
    const locked = dets.filter((p) => p.locked).length;
    setText($("ghostWaitingText"), state.phase === "select" ? `The detectives are choosing… ${locked} of ${dets.length} locked in.` : "The veil is lifted. Waiting for the host to continue.");
  }

  const hand = state.hand || [];
  for (const id of [...selectedCards]) if (!hand.some((c) => c.id === id)) selectedCards.delete(id);
  if (selectedTarget && !dets.some((p) => p.id === selectedTarget)) selectedTarget = null;
  if (!selectedTarget && dets.length === 1) selectedTarget = dets[0].id;

  setText($("handCount"), plural(hand.length, "CARD"));
  setText($("handHint"), hand.length
    ? "Tap cards to select them – you can give several cards to the same detective at once."
    : "All cards given. Shuffle for a brand-new hand, or end giving clues.");
  reconcile($("ghostHand"), hand, (c) => c.id, (c) => evidenceCardEl(c, true), (el, c) => {
    toggle(el, "selected", selectedCards.has(c.id));
    el.setAttribute("aria-pressed", selectedCards.has(c.id));
  });

  reconcile($("targetList"), dets, (p) => p.id,
    (p) => { const b = document.createElement("button"); b.type = "button"; b.className = "target-btn"; b.dataset.target = p.id; return b; },
    (b, p) => { setText(b, p.name); b.style.setProperty("--c", p.color); toggle(b, "active", selectedTarget === p.id); b.disabled = state.paused; });

  const n = selectedCards.size;
  const target = dets.find((p) => p.id === selectedTarget);
  const give = $("giveBtn");
  setText(give, n && target ? `GIVE ${plural(n, "CARD")} TO ${target.name.toUpperCase()}` : n ? "NOW CHOOSE A DETECTIVE" : target ? "NOW SELECT CARDS" : "SELECT CARDS AND A DETECTIVE");
  give.disabled = !n || !target || !dist || state.paused;

  setText($("shuffleCount"), `${d.shuffleRemaining} LEFT`);
  $("shuffleBtn").disabled = !dist || state.paused;
  toggle($("shuffleBtn"), "dim", d.shuffleRemaining <= 0);
  $("endCluesBtn").disabled = !dist || state.paused;
  toggle($("endCluesBtn"), "dim", d.given < 1);
  setText($("distributionHint"), `${plural(d.given, "clue")} given this round · ${state.deckCount ?? 0} cards in the deck. Shuffle sends every card you did not give back to the deck and draws ${d.handSize} new ones.`);

  const ass = state.secretAssignments || [];
  setHTML($("secretAssignments"), ass.map((a) => `
    <div class="secret-row">
      <img src="${asset(a.killerImage)}" alt="">
      <div><b style="color:${a.color}">${esc(a.name)}</b><small>${esc(a.killerName)} · #${a.position}</small></div>
      <em>${a.dropped ? "LEFT" : a.solved ? "SOLVED" : a.connected ? "UNSOLVED" : "AWAY"}</em>
    </div>`).join(""));

  reconcile($("sentOverview"), ass, (a) => a.playerId,
    (a) => {
      const row = document.createElement("div"); row.className = "sent-row";
      row.innerHTML = `<div class="sent-head"><i class="legend-dot"></i><span class="sent-name"></span><small class="sent-count"></small></div><div class="sent-thumbs"></div>`;
      return row;
    },
    (row, a) => {
      row.querySelector(".legend-dot").style.background = a.color;
      setText(row.querySelector(".sent-name"), a.name);
      setText(row.querySelector(".sent-count"), plural(a.given.length, "clue"));
      reconcile(row.querySelector(".sent-thumbs"), a.given, (c) => c.id,
        (c) => { const s = document.createElement("span"); s.className = "thumb"; s.appendChild(makeImg(c.image, c.name)); s.title = c.name; return s; },
        (s, c) => toggle(s, "current", c.round === state.round));
    });
}

/* ----- detective ----- */
function renderDetective(me, myPawn) {
  const target = me.solved || me.dropped ? "obsEvidence" : "myEvidence";
  const countEl = me.solved || me.dropped ? "obsEvidenceCount" : "myEvidenceCount";
  const cards = (state.myEvidence || []).map((c, i) => ({ ...c, i }));
  cards.sort((a, b) => (b.round - a.round) || (a.i - b.i)); // newest round first
  const fresh = cards.filter((c) => c.isNew).length;
  setText($(countEl), plural(cards.length, "CARD"));
  const grid = $(target);
  reconcile(grid, cards, (c) => c.id, (c) => {
    const el = document.createElement("div");
    el.className = "evidence-display pop-in"; el.setAttribute("role", "button"); el.tabIndex = 0;
    el.innerHTML = `<div class="card-img"></div><span class="new-tag">NEW</span><strong></strong><p></p>`;
    el.querySelector(".card-img").appendChild(makeImg(c.image, c.name));
    setText(el.querySelector("strong"), c.name);
    setText(el.querySelector("p"), c.description || "A clue from beyond.");
    return el;
  }, (el, c) => { toggle(el, "is-new", c.isNew); el._card = c; });
  const empty = !cards.length;
  setText($("evidenceHint"), empty ? "No evidence has reached you yet. The Ghost is choosing…"
    : `${fresh ? plural(fresh, "new clue") + " this round. " : ""}Evidence stays in your case file for the whole game. Tap a card to enlarge it.`);
}

function renderDock(ghost, me, myPawn) {
  const show = !ghost && !me.solved && !me.dropped && state.phase === "select";
  toggle($("dock"), "hidden", !show);
  document.body.classList.toggle("has-dock", show);
  if (!show) return;
  const pos = localPick ?? (myPawn ? myPawn.position : null);
  const s = pos ? state.board[pos - 1] : null;
  const locked = !!(myPawn && myPawn.locked);
  setHTML($("dockPick"), s
    ? `<img src="${asset(s.image)}" alt=""><div><small>${locked ? "LOCKED IN" : "YOUR CHOICE"}</small><b>#${s.position} · ${esc(s.name)}</b></div>`
    : `<div><small>YOUR CHOICE</small><b class="muted">Tap a suspect on the board</b></div>`);
  const btn = $("lockBtn");
  btn.className = locked ? "secondary-btn" : "primary-btn";
  btn.firstChild.textContent = locked ? "CHANGE MY CHOICE " : "LOCK IN MY CHOICE ";
  btn.lastElementChild.textContent = locked ? "↺" : "↗";
  btn.disabled = state.paused || (!locked && !s);
}

/* ---------------- end screen ---------------- */
function renderEnd() {
  const r = state.result; if (!r) return;
  const me = state.you;
  const ghost = me.role === "ghost";
  const mine = r.detectives.find((d) => d.id === me.id);
  const won = ghost ? r.winner === "ghost" : !!(mine && mine.solved);
  $("endScreen").classList.toggle("personal-win", won);
  $("endScreen").classList.toggle("personal-loss", !won);
  setText($("endSymbol"), r.winner === "ghost" ? "☾" : "✦");
  setText($("endTitle"), ghost ? (won ? "The séance is complete." : "The detectives uncovered the truth.")
    : won ? "You solved your case." : "Your case remains unsolved.");
  setText($("endSubtitle"), ghost ? (won ? "Your clues kept the truth hidden until the final round." : "The detectives found the answers behind your signs.")
    : won ? "You identified your hidden culprit." : "The final testimony reveals the culprit you were seeking.");
  setHTML($("finalResults"), `<div class="final-row ghost-row"><div class="final-who"><b>THE GHOST</b><span>${esc(r.ghost || "Unknown")}</span></div><small>ROUNDS PLAYED: ${r.roundsUsed}</small></div>` +
    r.detectives.map((d) => `
      <div class="final-row ${d.solved ? "ok" : ""}">
        <img src="${asset(d.killerImage)}" alt="">
        <div class="final-who"><b style="color:${d.color}">${esc(d.name)}</b><span>${esc(d.killerName || "Unknown")}</span></div>
        <small>${d.dropped ? "LEFT THE GAME" : d.solved ? "SOLVED" : "UNSOLVED"} · ${d.correct} ✓ · ${d.incorrect} ✗</small>
      </div>`).join(""));
  toggle($("rematchBtn"), "hidden", !isAdmin());
  toggle($("rematchWait"), "hidden", isAdmin());
}

/* ---------------- sound ---------------- */
function startAmbient() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    osc = audioCtx.createOscillator(); gain = audioCtx.createGain();
    osc.type = "sine"; osc.frequency.value = 54; gain.gain.value = 0.012;
    osc.connect(gain); gain.connect(audioCtx.destination); osc.start();
  } catch { /* audio not available */ }
}
function stopAmbient() { try { if (osc) osc.stop(); } catch { /* ignore */ } osc = null; }
function toggleSound() {
  soundOn = !soundOn;
  setText($("ambientToggle"), soundOn ? "SOUND ON" : "SOUND OFF");
  toggle($("soundToggle"), "on", soundOn);
  if (soundOn) startAmbient(); else stopAmbient();
}

/* ---------------- events (all delegated, so re-rendering never loses a click) ---------------- */
const activate = (e) => e.type === "click" || e.key === "Enter" || e.key === " ";

$("homeForm").addEventListener("submit", (e) => { e.preventDefault(); joinRoom(); });
$("createRoom").addEventListener("click", createRoom);
$("roomCode").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });

$("copyCode").addEventListener("click", async () => {
  const link = `${location.origin}/?room=${state.code}`;
  try { await navigator.clipboard.writeText(link); }
  catch { const t = document.createElement("textarea"); t.value = link; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch { /* ignore */ } t.remove(); }
  toast("Invite link copied.");
});

$("playerList").addEventListener("click", (e) => { const b = e.target.closest("[data-kick]"); if (b) emit("room:kick", { playerId: b.dataset.kick }); });
const settings = (over) => emit("room:configure", { rounds: state.settings.rounds, shuffleLimit: Number($("shuffleLimit").value), ghostId: $("ghostSelect").value, ...over });
$("roundOptions").addEventListener("click", (e) => { const b = e.target.closest("[data-round]"); if (b && isAdmin()) settings({ rounds: Number(b.dataset.round) }); });
$("ghostSelect").addEventListener("change", () => settings({}));
$("shuffleLimit").addEventListener("change", () => settings({}));
$("startGame").addEventListener("click", () => guarded(() => emit("game:start")));
$("closeRoom").addEventListener("click", async () => { if (await confirmDialog({ title: "Close this room?", text: "Everyone will be sent back to the start screen.", yes: "CLOSE ROOM", no: "CANCEL" })) emit("room:close"); });

// board: delegated click => works even if the page re-renders between mousedown and mouseup
function onBoardActivate(e) {
  if (!activate(e)) return;
  const card = e.target.closest(".suspect-card"); if (!card || !state) return;
  if (e.type === "keydown") e.preventDefault();
  const me = state.you, pos = Number(card.dataset.pos);
  if (me.role === "ghost") return;
  if (state.phase !== "select") { toast(state.phase === "distribute" ? "Wait for the Ghost to finish giving clues." : "The guessing is over for this round."); return; }
  if (me.solved) { toast("Your case is already solved."); return; }
  if (state.paused) { toast("The game is paused while a player reconnects."); return; }
  const pawn = state.pawns.find((p) => p.playerId === me.id);
  if (pawn && pawn.locked) { toast("Your choice is locked. Press “Change my choice” to pick again."); return; }
  const s = state.board[pos - 1];
  if (s.solvedBy) { toast("That suspect was already cleared by another detective."); return; }
  localPick = pos; render();
  emit("detective:select", { position: pos }).then((res) => { if (!res.ok && localPick === pos) { localPick = null; render(); } });
}
$("suspectBoard").addEventListener("click", onBoardActivate);
$("suspectBoard").addEventListener("keydown", onBoardActivate);

$("lockBtn").addEventListener("click", () => guarded(async () => {
  const pawn = state.pawns.find((p) => p.playerId === state.you.id);
  if (pawn && pawn.locked) { await emit("detective:unlock"); return; }
  if (localPick && (!pawn || pawn.position !== localPick)) await emit("detective:select", { position: localPick });
  await emit("detective:lock");
}));

$("revealArea").addEventListener("click", (e) => { if (e.target.closest("#nextRound")) guarded(() => emit("game:next-round")); });
$("dropList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-drop]"); if (!b) return;
  const p = state.players.find((x) => x.id === b.dataset.drop);
  if (await confirmDialog({ title: `Continue without ${p ? p.name : "this player"}?`, text: "They will be removed from the game and cannot rejoin.", yes: "CONTINUE", no: "KEEP WAITING" })) emit("game:drop", { playerId: b.dataset.drop });
});

$("secretToggle").addEventListener("click", () => {
  const list = $("secretAssignments"); list.classList.toggle("hidden");
  const open = !list.classList.contains("hidden");
  $("secretToggle").setAttribute("aria-expanded", open);
  $("secretToggle").innerHTML = `${open ? "HIDE" : "REVEAL"} SECRET ASSIGNMENTS <span>${open ? "−" : "＋"}</span>`;
});

// ghost hand
function onHandActivate(e) {
  if (!activate(e)) return;
  const zoom = e.target.closest(".zoom-btn");
  const el = e.target.closest(".evidence-card"); if (!el) return;
  const card = (state.hand || []).find((c) => c.id === el.dataset.key); if (!card) return;
  if (zoom) { e.stopPropagation(); openLightbox(card); return; }
  if (e.type === "keydown") e.preventDefault();
  if (state.phase !== "distribute" || state.paused) return;
  if (selectedCards.has(card.id)) selectedCards.delete(card.id); else selectedCards.add(card.id);
  renderGhost();
}
$("ghostHand").addEventListener("click", onHandActivate);
$("ghostHand").addEventListener("keydown", onHandActivate);
$("targetList").addEventListener("click", (e) => { const b = e.target.closest("[data-target]"); if (!b) return; selectedTarget = selectedTarget === b.dataset.target ? null : b.dataset.target; renderGhost(); });

$("giveBtn").addEventListener("click", () => guarded(async () => {
  const targetId = selectedTarget, cardIds = [...selectedCards];
  if (!targetId || !cardIds.length) return;
  const who = state.players.find((p) => p.id === targetId);
  const res = await emit("ghost:give", { targetId, cardIds });
  if (res.ok) { selectedCards.clear(); toast(`${plural(cardIds.length, "clue")} delivered to ${who ? who.name : "the detective"} in silence.`); }
}));

$("shuffleBtn").addEventListener("click", async () => {
  const d = state.distribution;
  if (d.shuffleRemaining <= 0) { toast("You have no shuffles left."); return; }
  const ok = await confirmDialog({
    title: "Shuffle your hand?",
    text: `Every card you did not give goes back into the deck and you draw ${d.handSize} brand-new random cards. You have ${plural(d.shuffleRemaining, "shuffle")} left this game.`,
    yes: "SHUFFLE", no: "CANCEL" });
  if (ok) guarded(async () => { selectedCards.clear(); await emit("ghost:shuffle"); });
});

$("endCluesBtn").addEventListener("click", async () => {
  const d = state.distribution;
  if (d.given < 1) { toast("Give at least one clue before ending."); return; }
  const left = (state.hand || []).length;
  const ok = await confirmDialog({
    title: "Are you sure?",
    text: `You gave ${plural(d.given, "clue")} this round${left ? ` and ${plural(left, "card")} will go back into the deck` : ""}. The detectives will start choosing their suspects and you cannot give more clues this round.`,
    yes: "YES, END CLUES", no: "NO, GO BACK" });
  if (ok) guarded(async () => { selectedCards.clear(); await emit("ghost:end-clues"); });
});

// detective evidence
function onEvidenceActivate(e) {
  if (!activate(e)) return;
  const el = e.target.closest(".evidence-display"); if (el && el._card) { if (e.type === "keydown") e.preventDefault(); openLightbox(el._card); }
}
for (const id of ["myEvidence", "obsEvidence"]) { $(id).addEventListener("click", onEvidenceActivate); $(id).addEventListener("keydown", onEvidenceActivate); }

// sent thumbnails (ghost) open the lightbox too
$("sentOverview").addEventListener("click", (e) => {
  const t = e.target.closest(".thumb"); if (!t || !state.secretAssignments) return;
  const row = t.closest(".sent-row"); const a = state.secretAssignments.find((x) => x.playerId === row.dataset.key);
  const c = a && a.given.find((x) => x.id === t.dataset.key); if (c) openLightbox(c);
});

$("rematchBtn").addEventListener("click", () => guarded(() => emit("game:rematch")));
$("returnHome").addEventListener("click", () => { safeLS.del(SESSION_KEY); location.href = "/"; });

$("modalYes").addEventListener("click", () => closeModal(true));
$("modalNo").addEventListener("click", () => closeModal(false));
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(false); });
$("lightbox").addEventListener("click", closeLightbox);
$("lightboxClose").addEventListener("click", closeLightbox);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("modal").classList.contains("hidden")) closeModal(false); closeLightbox(); } });

$("soundToggle").addEventListener("click", toggleSound);
$("ambientToggle").addEventListener("click", toggleSound);

// mobile browsers suspend sockets in the background – wake up when the player returns
const wake = () => { if (socket && !socket.connected) socket.connect(); };
document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
window.addEventListener("online", wake);

/* ---------------- boot ---------------- */
(function boot() {
  const saved = safeLS.get(NAME_KEY); if (saved) $("playerName").value = saved;
  const room = new URLSearchParams(location.search).get("room");
  if (room) { $("roomCode").value = room.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5); if (saved) $("roomCode").focus(); else $("playerName").focus(); }
  currentScreen = "homeScreen";
  connect(); // also resumes a saved session
})();
