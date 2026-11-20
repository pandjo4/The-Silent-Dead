/*
 * THE SILENT DEAD - game hub.
 *
 * All game rules live here. The module has no dependencies on Express or
 * Socket.IO so it can be unit-tested directly in Node (see /tests) and the
 * transport layer in server.js stays tiny.
 *
 * Round flow:
 *   distribute -> select -> reveal -> (next round | finished)
 *
 *   distribute: the Ghost holds 6 evidence cards. They may give any number of
 *               them (1-6) to any detectives, in any combination. Then they
 *               either END GIVING CLUES (detectives start guessing) or SHUFFLE:
 *               every card they did NOT give goes back to the deck and 6 fresh
 *               random cards are drawn. Shuffles are limited per game.
 *   select:     every active detective picks a suspect and locks in.
 *   reveal:     results are shown, the host continues.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SilentDeadHub = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const COLORS = ["#65a9e8", "#b18be7", "#e5c56c", "#69c9c8", "#e49a62", "#d47f9d"];
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const HAND_SIZE = 6;
  const BOARD_SIZE = 9;
  const MAX_PLAYERS = 6;
  const CLEANUP_MS = 10 * 60 * 1000;

  class GameError extends Error {}
  const fail = (msg) => { throw new GameError(msg); };

  function createHub(opts) {
    const evidence = opts.evidence;
    const suspects = opts.suspects;
    const send = opts.send || (() => {});
    const random = opts.random || Math.random;
    const setTimer = opts.setTimer || setTimeout;
    const clearTimer = opts.clearTimer || clearTimeout;
    const log = opts.log || (() => {});
    const uid = opts.uid || (() => {
      let s = "";
      for (let i = 0; i < 32; i++) s += Math.floor(random() * 16).toString(16);
      return s;
    });

    // Optional card->suspect fit table (public/data/matches.json). Without it, hands are plain random.
    const matches = opts.matches && opts.matches.cards ? opts.matches : null;
    const omni = new Set((matches && matches.omni) || []);
    const MIN_USEFUL = 2, MAX_DEAD = 1, MAX_BROAD = 1; // per hand

    const rooms = new Map();
    const sessions = new Map(); // socketId -> { code, playerId }
    const evidenceById = new Map(evidence.map((e) => [e.id, e]));
    const suspectById = new Map(suspects.map((s) => [s.id, s]));

    /* ---------- helpers ---------- */
    const pick = (arr) => arr[Math.floor(random() * arr.length)];
    const shuffle = (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const clampInt = (v, min, max, fallback) => {
      const n = Number(v);
      return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
    };
    const safeName = (s) => String(s || "").replace(/[<>]/g, "").trim().slice(0, 18) || "Player";

    function makeCode() {
      let c;
      do {
        c = "";
        for (let i = 0; i < 5; i++) c += pick(CODE_CHARS.split(""));
      } while (rooms.has(c));
      return c;
    }

    const detectives = (r) => r.players.filter((p) => p.role === "detective");
    const activeDetectives = (r) => detectives(r).filter((p) => !p.solved && !p.dropped);
    const inGame = (r) => r.phase !== "lobby" && r.phase !== "finished";
    const presentPlayers = (r) => r.players.filter((p) => !p.dropped);

    /** Cards that are not in any detective's case file = the deck. */
    function deckIds(r) {
      const given = new Set();
      for (const p of r.players) for (const id of p.evidence) given.add(id);
      return evidence.map((e) => e.id).filter((id) => !given.has(id));
    }

    /**
     * Draw a fresh hand of up to HAND_SIZE random cards from the deck.
     * Cards from `previous` (the hand that was just returned to the deck) are
     * only used if there are not enough other cards, so a shuffle really gives
     * a new set whenever the deck allows it.
     */
    function drawHand(r, previous) {
      const prev = new Set(previous || []);
      const deck = deckIds(r);
      const fresh = shuffle(deck.filter((id) => !prev.has(id)));
      const old = shuffle(deck.filter((id) => prev.has(id)));
      const pool = fresh.concat(old);
      return matches && r.board && r.board.length ? balancedHand(r, pool) : pool.slice(0, HAND_SIZE);
    }

    /**
     * Picks HAND_SIZE cards from `pool` (already ordered by preference) so that the hand is playable:
     *  - at least MIN_USEFUL cards fit a culprit of a detective who is still investigating,
     *  - at most MAX_DEAD cards fit nobody on this board, at most MAX_BROAD fit (almost) everybody.
     * If the pool cannot satisfy the rules it simply falls back to the best it can do.
     */
    function balancedHand(r, pool) {
      const boardIds = new Set(r.board.map((s) => s.id));
      const killers = new Set(activeDetectives(r).map((p) => p.killerId));
      const fit = (id) => (omni.has(id) ? boardIds.size : (matches.cards[id] || []).filter((sid) => boardIds.has(sid)).length);
      const kind = (id) => { const f = fit(id); return f === 0 ? "dead" : (omni.has(id) || f >= 6) ? "broad" : "good"; };
      const useful = (id) => kind(id) === "good" && (matches.cards[id] || []).some((sid) => killers.has(sid));
      const hand = [];
      const take = (id) => { hand.push(id); };
      for (const id of pool) { if (hand.length >= MIN_USEFUL) break; if (useful(id)) take(id); }
      let dead = 0, broad = 0;
      for (const id of pool) {
        if (hand.length >= HAND_SIZE) break;
        if (hand.includes(id)) continue;
        const k = kind(id);
        if (k === "dead" && dead >= MAX_DEAD) continue;
        if (k === "broad" && broad >= MAX_BROAD) continue;
        if (k === "dead") dead++; if (k === "broad") broad++;
        take(id);
      }
      for (const id of pool) { if (hand.length >= HAND_SIZE) break; if (!hand.includes(id)) take(id); } // pool too small: fill up
      return shuffle(hand);
    }

    /* ---------- state projection ---------- */
    function evidenceCard(id, extra) {
      const e = evidenceById.get(id);
      return e ? Object.assign({ id: e.id, name: e.name, image: e.image, description: e.description || "" }, extra) : null;
    }

    function publicState(r) {
      const solvedBy = new Map();
      for (const p of detectives(r)) if (p.solved) solvedBy.set(p.killerId, p.id);
      return {
        code: r.code,
        adminId: r.adminId,
        ghostId: r.ghostId,
        randomGhost: !!r.randomGhost,
        settings: r.settings,
        phase: r.phase,
        round: r.round,
        maxRounds: r.settings.rounds,
        players: r.players.map((p) => ({
          id: p.id, name: p.name, color: p.color, connected: p.connected, role: p.role,
          solved: !!p.solved, dropped: !!p.dropped, locked: !!p.locked,
          evidenceCount: p.evidence.length,
        })),
        board: r.board.map((s, i) => ({
          id: s.id, name: s.name, image: s.image, position: i + 1, solvedBy: solvedBy.get(s.id) || null,
        })),
        pawns: detectives(r).map((p) => ({
          playerId: p.id, name: p.name, color: p.color, position: p.selection, locked: !!p.locked,
          solved: !!p.solved, dropped: !!p.dropped,
        })),
        distribution: {
          given: r.givenThisRound,
          shuffleRemaining: r.shuffleRemaining,
          shuffleLimit: r.settings.shuffleLimit,
          handSize: HAND_SIZE,
        },
        reveal: r.reveal,
        result: r.result,
        paused: r.paused,
        pauseReason: r.pauseReason,
      };
    }

    function privateState(r, p) {
      const base = publicState(r);
      base.you = { id: p.id, name: p.name, role: p.role, isAdmin: p.id === r.adminId, solved: !!p.solved, dropped: !!p.dropped };
      if (p.role === "ghost") {
        base.hand = r.ghostHand.map((id) => evidenceCard(id)).filter(Boolean);
        base.deckCount = deckIds(r).length - r.ghostHand.length;
        base.secretAssignments = detectives(r).map((x) => {
          const s = suspectById.get(x.killerId);
          return {
            playerId: x.id, name: x.name, color: x.color, killerId: x.killerId,
            killerName: s ? s.name : "", killerImage: s ? s.image : "",
            position: r.board.findIndex((b) => b.id === x.killerId) + 1,
            solved: !!x.solved, dropped: !!x.dropped, connected: x.connected,
            given: x.evidence.map((id) => evidenceCard(id, { round: x.evidenceRound[id] })).filter(Boolean),
          };
        });
      } else if (p.role === "detective") {
        base.myEvidence = p.evidence
          .map((id) => evidenceCard(id, { round: p.evidenceRound[id], isNew: p.evidenceRound[id] === r.round }))
          .filter(Boolean);
      }
      return base;
    }

    function broadcast(r) {
      for (const p of r.players) {
        if (p.socketId) send(p.socketId, "game:state", privateState(r, p));
      }
    }

    /* ---------- game flow ---------- */
    function startRound(r) {
      r.phase = "distribute";
      r.givenThisRound = 0;
      for (const p of detectives(r)) { p.selection = null; p.locked = false; }
      r.ghostHand = drawHand(r, r.returned || []);
      r.returned = [];
      r.reveal = null;
    }

    function createGame(r) {
      let ghost;
      if (r.randomGhost || !r.ghostId) {
        if (!r.randomGhost) fail("Choose who will be the Ghost.");
        ghost = pick(r.players);
        r.ghostId = ghost.id;
      } else {
        ghost = r.players.find((p) => p.id === r.ghostId);
      }
      if (!ghost) fail("Choose who will be the Ghost.");
      const dets = r.players.filter((p) => p.id !== ghost.id);
      if (dets.length < 1) fail("At least one detective is needed.");
      if (suspects.length < BOARD_SIZE) fail("Not enough suspects in the database.");
      if (evidence.length < HAND_SIZE * 2) fail("Not enough evidence cards in the database.");
      r.board = shuffle(suspects).slice(0, BOARD_SIZE);
      const killers = shuffle(r.board.map((s) => s.id)).slice(0, dets.length);
      r.players.forEach((p) => {
        p.evidence = []; p.evidenceRound = {}; p.selection = null; p.locked = false;
        p.solved = false; p.dropped = false; p.correct = 0; p.incorrect = 0; p.killerId = null;
      });
      dets.forEach((p, i) => { p.role = "detective"; p.killerId = killers[i]; });
      ghost.role = "ghost";
      r.shuffleRemaining = r.settings.shuffleLimit;
      r.round = 1;
      r.result = null;
      r.returned = [];
      r.paused = false;
      r.pauseReason = "";
      startRound(r);
    }

    function finishGame(r) {
      const dets = detectives(r).filter((p) => !p.dropped);
      const detectivesWin = dets.length > 0 && dets.every((p) => p.solved);
      r.phase = "finished";
      r.ghostHand = [];
      r.paused = false;
      r.pauseReason = "";
      const ghost = r.players.find((p) => p.role === "ghost");
      r.result = {
        winner: detectivesWin ? "detectives" : "ghost",
        roundsUsed: r.round,
        ghost: ghost ? ghost.name : "",
        detectives: detectives(r).map((p) => {
          const s = suspectById.get(p.killerId);
          return {
            id: p.id, name: p.name, color: p.color, killerId: p.killerId,
            killerName: s ? s.name : "", killerImage: s ? s.image : "",
            solved: !!p.solved, dropped: !!p.dropped, correct: p.correct, incorrect: p.incorrect,
          };
        }),
      };
    }

    function resolveSelectIfReady(r) {
      if (r.phase !== "select") return;
      const active = activeDetectives(r);
      if (active.length === 0) { finishGame(r); return; }
      if (!active.every((p) => p.locked && p.selection)) return;
      const results = active.map((p) => {
        const chosen = r.board[p.selection - 1];
        const correct = chosen.id === p.killerId;
        if (correct) { p.solved = true; p.correct++; } else p.incorrect++;
        return {
          playerId: p.id, name: p.name, color: p.color, position: p.selection,
          suspectName: chosen.name, suspectImage: chosen.image, correct, solved: !!p.solved,
        };
      });
      r.phase = "reveal";
      r.reveal = { round: r.round, results, final: activeDetectives(r).length === 0 || r.round >= r.settings.rounds };
    }

    function resumeIfReady(r) {
      if (r.paused && presentPlayers(r).every((p) => p.connected)) { r.paused = false; r.pauseReason = ""; }
    }

    function cleanRoom(r) {
      if (r.players.every((p) => !p.connected)) {
        if (r.cleanupTimer) clearTimer(r.cleanupTimer);
        r.cleanupTimer = setTimer(() => {
          if (rooms.get(r.code) === r && r.players.every((p) => !p.connected)) rooms.delete(r.code);
        }, CLEANUP_MS);
        if (r.cleanupTimer && r.cleanupTimer.unref) r.cleanupTimer.unref();
      } else if (r.cleanupTimer) {
        clearTimer(r.cleanupTimer);
        r.cleanupTimer = null;
      }
    }

    /* ---------- context helpers ---------- */
    function ctx(socketId) {
      const s = sessions.get(socketId);
      const r = s && rooms.get(s.code);
      if (!r) fail("Room not found.");
      const p = r.players.find((x) => x.id === s.playerId);
      if (!p) fail("Player not found.");
      return { r, p };
    }
    const needPhase = (r, phase) => {
      if (r.paused) fail("The game is paused while a player reconnects.");
      if (r.phase !== phase) fail("That action is not available right now.");
    };
    const needAdmin = (r, p, msg) => { if (p.id !== r.adminId) fail(msg || "Only the host can do that."); };
    const needGhost = (p) => { if (p.role !== "ghost") fail("Only the Ghost can do that."); };

    function newPlayer(name, socketId, r) {
      let base = safeName(name);
      let finalName = base;
      if (r) {
        let n = 2;
        while (r.players.some((x) => x.name.toLowerCase() === finalName.toLowerCase())) finalName = `${base.slice(0, 15)} ${n++}`;
      }
      return {
        id: uid(), token: uid(), name: finalName, color: COLORS[0], role: "unassigned",
        connected: true, socketId, evidence: [], evidenceRound: {}, solved: false, dropped: false,
        selection: null, locked: false, correct: 0, incorrect: 0, killerId: null,
      };
    }

    function detach(socketId) {
      const s = sessions.get(socketId);
      sessions.delete(socketId);
      if (!s) return;
      const r = rooms.get(s.code);
      const p = r && r.players.find((x) => x.id === s.playerId);
      if (!p || p.socketId !== socketId) return;
      p.connected = false;
      p.socketId = null;
      if (inGame(r) && !p.dropped) {
        r.paused = true;
        r.pauseReason = `${p.name} disconnected. Waiting for them to reconnect…`;
      }
      broadcast(r);
      cleanRoom(r);
    }

    function attach(socketId, r, p) {
      sessions.set(socketId, { code: r.code, playerId: p.id });
      p.socketId = socketId;
      p.connected = true;
    }

    /* ---------- event handlers ---------- */
    const handlers = {
      "room:create"(socketId, payload) {
        detach(socketId);
        const code = makeCode();
        const p = newPlayer(payload.name, socketId, null);
        const r = {
          code, adminId: p.id, players: [p], ghostId: null, randomGhost: false,
          settings: { rounds: clampInt(payload.rounds, 1, 6, 4), shuffleLimit: clampInt(payload.shuffleLimit, 0, 5, 3) },
          phase: "lobby", round: 0, board: [], ghostHand: [], returned: [], givenThisRound: 0,
          shuffleRemaining: 3, reveal: null, result: null, paused: false, pauseReason: "", cleanupTimer: null,
        };
        rooms.set(code, r);
        attach(socketId, r, p);
        return { ok: true, code, playerId: p.id, token: p.token, state: privateState(r, p) };
      },

      "room:join"(socketId, payload) {
        const code = String(payload.code || "").toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) fail("Room code not found.");
        if (r.phase !== "lobby") fail("This game has already started.");
        if (r.players.length >= MAX_PLAYERS) fail("This room is full.");
        detach(socketId);
        const p = newPlayer(payload.name, socketId, r);
        const used = new Set(r.players.map((x) => x.color));
        p.color = COLORS.find((c) => !used.has(c)) || COLORS[0];
        r.players.push(p);
        attach(socketId, r, p);
        cleanRoom(r);
        broadcast(r);
        return { ok: true, code: r.code, playerId: p.id, token: p.token, state: privateState(r, p) };
      },

      "room:reconnect"(socketId, payload) {
        const r = rooms.get(String(payload.code || "").toUpperCase());
        const p = r && r.players.find((x) => x.id === payload.playerId && x.token === payload.token);
        if (!r || !p) fail("Reconnect details are invalid or the room has expired.");
        if (p.dropped) fail("You were removed from this game.");
        if (p.socketId && p.socketId !== socketId) {
          sessions.delete(p.socketId);
          if (opts.disconnect) opts.disconnect(p.socketId);
        }
        detach(socketId); // if this socket was attached to another room
        attach(socketId, r, p);
        cleanRoom(r);
        resumeIfReady(r);
        broadcast(r);
        return { ok: true, code: r.code, playerId: p.id, token: p.token, state: privateState(r, p) };
      },

      "room:configure"(socketId, payload) {
        const { r, p } = ctx(socketId);
        needAdmin(r, p, "Only the host can change settings.");
        if (r.phase !== "lobby") fail("The game has already started.");
        r.settings.rounds = clampInt(payload.rounds, 1, 6, r.settings.rounds);
        r.settings.shuffleLimit = clampInt(payload.shuffleLimit, 0, 5, r.settings.shuffleLimit);
        if (payload.ghostId === "random") { r.randomGhost = true; r.ghostId = null; }
        else if (payload.ghostId && r.players.some((x) => x.id === payload.ghostId)) { r.randomGhost = false; r.ghostId = payload.ghostId; }
        else if (payload.ghostId === "") { r.randomGhost = false; r.ghostId = null; }
        broadcast(r);
        return { ok: true };
      },

      "room:kick"(socketId, payload) {
        const { r, p } = ctx(socketId);
        needAdmin(r, p, "Only the host can remove players.");
        if (r.phase !== "lobby") fail("Players cannot be removed after the game starts.");
        const t = r.players.find((x) => x.id === payload.playerId);
        if (!t || t.id === r.adminId) fail("Invalid player.");
        if (t.socketId) { sessions.delete(t.socketId); send(t.socketId, "room:removed", {}); }
        r.players = r.players.filter((x) => x.id !== t.id);
        if (r.ghostId === t.id) r.ghostId = null;
        broadcast(r);
        return { ok: true };
      },

      "room:close"(socketId) {
        const { r, p } = ctx(socketId);
        needAdmin(r, p, "Only the host can close the room.");
        for (const x of r.players) {
          if (x.socketId) { sessions.delete(x.socketId); send(x.socketId, "room:removed", {}); }
        }
        if (r.cleanupTimer) clearTimer(r.cleanupTimer);
        rooms.delete(r.code);
        return { ok: true };
      },

      "game:start"(socketId) {
        const { r, p } = ctx(socketId);
        needAdmin(r, p, "Only the host can start the game.");
        if (r.phase !== "lobby") fail("The game has already started.");
        if (r.players.length < 2) fail("At least two players are required.");
        if (!r.randomGhost && !r.players.some((x) => x.id === r.ghostId)) fail("Choose who will be the Ghost.");
        if (r.players.some((x) => !x.connected)) fail("Every player must be connected before the game can start.");
        createGame(r);
        broadcast(r);
        return { ok: true };
      },

      /** Ghost gives one or more cards from the hand to one detective. */
      "ghost:give"(socketId, payload) {
        const { r, p } = ctx(socketId);
        needGhost(p);
        needPhase(r, "distribute");
        const target = r.players.find((x) => x.id === payload.targetId && x.role === "detective" && !x.solved && !x.dropped);
        if (!target) fail("Choose a detective who is still investigating.");
        const ids = Array.isArray(payload.cardIds) ? payload.cardIds : payload.cardId ? [payload.cardId] : [];
        const unique = [...new Set(ids.map(String))];
        if (unique.length === 0) fail("Select at least one card to give.");
        if (!unique.every((id) => r.ghostHand.includes(id))) fail("One of those cards is not in your hand.");
        for (const id of unique) {
          target.evidence.push(id);
          target.evidenceRound[id] = r.round;
        }
        r.ghostHand = r.ghostHand.filter((id) => !unique.includes(id));
        r.givenThisRound += unique.length;
        broadcast(r);
        return { ok: true, given: unique.length };
      },

      /** Ghost is done: unused cards go back to the deck and detectives guess. */
      "ghost:end-clues"(socketId) {
        const { r, p } = ctx(socketId);
        needGhost(p);
        needPhase(r, "distribute");
        const canGiveMore = r.ghostHand.length > 0 || drawHand(r, []).length > 0;
        if (r.givenThisRound < 1 && canGiveMore) fail("Give at least one clue before ending this round of clues.");
        r.returned = [...r.ghostHand];
        r.ghostHand = [];
        r.phase = "select";
        broadcast(r);
        return { ok: true };
      },

      /** Ghost throws away the whole hand: all unused cards return to the deck, 6 new random cards are drawn. */
      "ghost:shuffle"(socketId) {
        const { r, p } = ctx(socketId);
        needGhost(p);
        needPhase(r, "distribute");
        if (r.shuffleRemaining <= 0) fail("You have no shuffles left.");
        const previous = [...r.ghostHand];
        const next = drawHand(r, previous);
        if (next.length === 0) fail("There are no cards left in the deck.");
        if (previous.length > 0 && next.every((id) => previous.includes(id))) fail("There are no other cards left in the deck to draw.");
        r.ghostHand = next;
        r.shuffleRemaining--;
        broadcast(r);
        return { ok: true };
      },

      "detective:select"(socketId, payload) {
        const { r, p } = ctx(socketId);
        if (p.role !== "detective" || p.solved || p.dropped) fail("You cannot choose a suspect right now.");
        needPhase(r, "select");
        if (p.locked) fail("Your choice is locked. Press “Change choice” first.");
        let pos = Number(payload.position);
        // The suspect id (when sent) wins over the number: a client with a stale board can never pick the wrong face.
        if (typeof payload.suspectId === "string") { const i = r.board.findIndex((b) => b.id === payload.suspectId); if (i >= 0) pos = i + 1; }
        if (!Number.isInteger(pos) || pos < 1 || pos > BOARD_SIZE) fail("Choose a suspect from 1 to 9.");
        const s = r.board[pos - 1];
        if (detectives(r).some((x) => x.solved && x.killerId === s.id)) fail("That suspect has already been cleared by another detective.");
        p.selection = pos;
        broadcast(r);
        return { ok: true };
      },

      "detective:lock"(socketId) {
        const { r, p } = ctx(socketId);
        if (p.role !== "detective" || p.solved || p.dropped) fail("You cannot lock a choice right now.");
        needPhase(r, "select");
        if (!p.selection) fail("Choose a suspect first.");
        p.locked = true;
        resolveSelectIfReady(r);
        broadcast(r);
        return { ok: true };
      },

      "detective:unlock"(socketId) {
        const { r, p } = ctx(socketId);
        if (p.role !== "detective" || p.solved || p.dropped) fail("You cannot change your choice.");
        needPhase(r, "select");
        p.locked = false;
        broadcast(r);
        return { ok: true };
      },

      "game:next-round"(socketId) {
        const { r, p } = ctx(socketId);
        needAdmin(r, p, "Only the host can continue.");
        if (r.paused) fail("The game is paused while a player reconnects.");
        if (r.phase !== "reveal") fail("The reveal is not finished yet.");
        if (activeDetectives(r).length === 0 || r.round >= r.settings.rounds) finishGame(r);
        else { r.round++; startRound(r); }
        broadcast(r);
        return { ok: true };
      },

      /** Host removes a disconnected detective so the others can carry on. */
      "game:drop"(socketId, payload) {
        const { r, p } = ctx(socketId);
        needAdmin(r, p, "Only the host can remove players.");
        if (!inGame(r)) fail("That action is not available right now.");
        const t = r.players.find((x) => x.id === payload.playerId);
        if (!t || t.id === r.adminId) fail("Invalid player.");
        if (t.role === "ghost") fail("The Ghost cannot be removed during a game.");
        if (t.connected) fail("That player is connected.");
        t.dropped = true;
        t.locked = false;
        resumeIfReady(r);
        if (r.phase === "select") resolveSelectIfReady(r);
        else if (r.phase === "reveal" && r.reveal) r.reveal.final = r.reveal.final || activeDetectives(r).length === 0;
        else if (activeDetectives(r).length === 0) finishGame(r);
        broadcast(r);
        return { ok: true };
      },

      /** Host sends everyone back to the lobby for another game. */
      "game:rematch"(socketId) {
        const { r, p } = ctx(socketId);
        needAdmin(r, p, "Only the host can start a new game.");
        if (r.phase !== "finished") fail("The game is not finished yet.");
        r.players = r.players.filter((x) => !x.dropped && x.connected);
        for (const x of r.players) {
          x.role = "unassigned"; x.evidence = []; x.evidenceRound = {}; x.solved = false; x.locked = false;
          x.selection = null; x.killerId = null; x.correct = 0; x.incorrect = 0;
        }
        r.phase = "lobby"; r.round = 0; r.board = []; r.ghostHand = []; r.returned = []; r.reveal = null;
        r.result = null; r.givenThisRound = 0; r.paused = false; r.pauseReason = "";
        r.ghostId = r.randomGhost ? null : (r.players.some((x) => x.id === r.ghostId) ? r.ghostId : null);
        broadcast(r);
        return { ok: true };
      },
    };

    return {
      rooms,
      sessions,
      handle(socketId, event, payload) {
        const fn = handlers[event];
        if (!fn) return { ok: false, message: "Unknown action." };
        try {
          const res = fn(socketId, payload && typeof payload === "object" ? payload : {});
          return res || { ok: true };
        } catch (e) {
          if (!(e instanceof GameError)) log(e);
          return { ok: false, message: e instanceof GameError ? e.message : "Something went wrong on the server." };
        }
      },
      disconnect(socketId) { detach(socketId); },
    };
  }

  return { createHub, HAND_SIZE, BOARD_SIZE, MAX_PLAYERS, COLORS };
});
