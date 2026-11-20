// Run with: node tests/hub.test.js   (no dependencies needed)
const assert = require("assert");
const path = require("path");
const { createHub, HAND_SIZE } = require("../server/hub");
const evidence = require(path.join(__dirname, "..", "public", "data", "evidence.json"));
const suspects = require(path.join(__dirname, "..", "public", "data", "suspects.json"));

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok -", name); };

function setup(nPlayers, { rounds = 4, shuffleLimit = 3 } = {}) {
  const inbox = new Map();
  const removed = [];
  const hub = createHub({
    evidence, suspects,
    send: (sid, ev, data) => { if (ev === "game:state") inbox.set(sid, data); else if (ev === "room:removed") removed.push(sid); },
  });
  const ids = []; let code; const players = [];
  for (let i = 0; i < nPlayers; i++) {
    const sid = "s" + i; ids.push(sid);
    const res = i === 0 ? hub.handle(sid, "room:create", { name: "P" + i, rounds, shuffleLimit }) : hub.handle(sid, "room:join", { name: "P" + i, code });
    assert(res.ok, res.message); if (i === 0) code = res.code;
    players.push({ sid, id: res.playerId, token: res.token });
  }
  const room = hub.rooms.get(code);
  const call = (i, ev, payload) => hub.handle(ids[i], ev, payload);
  const st = (i) => inbox.get(ids[i]);
  return { hub, room, ids, players, call, st, code, removed, inbox };
}
function startGame(g, ghostIndex = 0) {
  assert(g.call(0, "room:configure", { ghostId: g.players[ghostIndex].id }).ok);
  const r = g.call(0, "game:start"); assert(r.ok, r.message);
  return g.room;
}
const detIdx = (g) => g.players.map((_, i) => i).filter((i) => g.room.players[i].role === "detective");
const deckConservation = (g) => {
  const given = g.room.players.reduce((n, p) => n + p.evidence.length, 0);
  const deck = evidence.length - given;
  assert(g.room.ghostHand.length <= deck, "hand must come from the deck");
  const all = [...g.room.players.flatMap((p) => p.evidence), ...g.room.ghostHand];
  assert.strictEqual(new Set(all).size, all.length, "no duplicate cards between hand and case files");
};

test("ghost starts with 6 unique cards", () => {
  const g = setup(3); startGame(g);
  assert.strictEqual(g.room.ghostHand.length, HAND_SIZE);
  assert.strictEqual(new Set(g.room.ghostHand).size, HAND_SIZE);
  assert.strictEqual(g.st(0).hand.length, HAND_SIZE);
  assert.strictEqual(g.room.phase, "distribute");
});

test("ghost can give 1, 1 and 4 cards to different detectives in one round", () => {
  const g = setup(4); startGame(g);
  const [a, b, c] = detIdx(g); const hand = [...g.room.ghostHand];
  assert(g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [hand[0]] }).ok);
  assert(g.call(0, "ghost:give", { targetId: g.players[b].id, cardIds: [hand[1]] }).ok);
  assert(g.call(0, "ghost:give", { targetId: g.players[c].id, cardIds: hand.slice(2, 6) }).ok);
  assert.strictEqual(g.room.ghostHand.length, 0);
  assert.strictEqual(g.st(a).myEvidence.length, 1);
  assert.strictEqual(g.st(b).myEvidence.length, 1);
  assert.strictEqual(g.st(c).myEvidence.length, 4);
  assert(g.st(c).myEvidence.every((e) => e.isNew));
  assert.strictEqual(g.st(0).distribution.given, 6);
  deckConservation(g);
});

test("cannot give cards that are not in hand / twice / to ghost / to nobody", () => {
  const g = setup(3); startGame(g); const [a] = detIdx(g); const hand = g.room.ghostHand;
  assert(!g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: ["nope"] }).ok);
  assert(!g.call(0, "ghost:give", { targetId: g.players[0].id, cardIds: [hand[0]] }).ok);
  assert(!g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [] }).ok);
  assert(!g.call(a, "ghost:give", { targetId: g.players[a].id, cardIds: [hand[0]] }).ok);
  const first = hand[0];
  assert(g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [first, first] }).ok);
  assert.strictEqual(g.room.players[a].evidence.length, 1);
  assert(!g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [first] }).ok);
});

test("cannot end clues without giving at least one card", () => {
  const g = setup(2); startGame(g);
  assert(!g.call(0, "ghost:end-clues").ok);
  const [a] = detIdx(g);
  g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [g.room.ghostHand[0]] });
  assert(g.call(0, "ghost:end-clues").ok);
  assert.strictEqual(g.room.phase, "select");
  assert.strictEqual(g.room.ghostHand.length, 0);
});

test("shuffle returns ALL unused cards to the deck and draws 6 brand-new ones", () => {
  for (let n = 0; n < 200; n++) {
    const g = setup(3); startGame(g); const [a] = detIdx(g);
    const before = [...g.room.ghostHand];
    g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: before.slice(0, 2) });
    const hand2 = [...g.room.ghostHand];
    assert.strictEqual(hand2.length, 4);
    assert(g.call(0, "ghost:shuffle").ok);
    assert.strictEqual(g.room.ghostHand.length, HAND_SIZE);
    assert(g.room.ghostHand.every((id) => !hand2.includes(id)), "shuffle gives completely new cards");
    assert(g.room.ghostHand.every((id) => !g.room.players[a].evidence.includes(id)), "never redraw given cards");
    assert.strictEqual(g.room.shuffleRemaining, 2);
    assert.strictEqual(g.room.players[a].evidence.length, 2, "given cards stay with the detective");
    deckConservation(g);
  }
});

test("shuffle works with an empty hand and respects the per-game limit", () => {
  const g = setup(2, { shuffleLimit: 2 }); startGame(g); const [a] = detIdx(g);
  g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [...g.room.ghostHand] });
  assert.strictEqual(g.room.ghostHand.length, 0);
  assert(g.call(0, "ghost:shuffle").ok); assert.strictEqual(g.room.ghostHand.length, 6);
  assert(g.call(0, "ghost:shuffle").ok);
  assert(!g.call(0, "ghost:shuffle").ok);
  const zero = setup(2, { shuffleLimit: 0 }); startGame(zero);
  assert(!zero.call(0, "ghost:shuffle").ok);
});

test("detective cards never disappear across rounds, shuffles and reconnects", () => {
  const g = setup(3, { rounds: 6 }); startGame(g);
  const [a, b] = detIdx(g); const mine = { [a]: new Set(), [b]: new Set() };
  for (let round = 1; round <= 5; round++) {
    const hand = g.room.ghostHand;
    g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: hand.slice(0, 2) });
    hand.slice(0, 2).forEach((x) => mine[a].add(x));
    g.call(0, "ghost:shuffle");
    const h2 = g.room.ghostHand;
    g.call(0, "ghost:give", { targetId: g.players[b].id, cardIds: [h2[0]] }); mine[b].add(h2[0]);
    g.call(0, "ghost:end-clues");
    for (const i of [a, b]) {
      const shown = g.st(i).myEvidence.map((e) => e.id);
      mine[i].forEach((id) => assert(shown.includes(id), "card vanished"));
    }
    // both pick a wrong suspect so the game continues
    for (const i of [a, b]) {
      const wrong = g.room.board.findIndex((s) => s.id !== g.room.players[i].killerId && !g.room.players.some((p) => p.solved && p.killerId === s.id)) + 1;
      g.call(i, "detective:select", { position: wrong }); g.call(i, "detective:lock");
    }
    assert.strictEqual(g.room.phase, "reveal");
    g.call(0, "game:next-round");
    // reconnect a detective on a fresh socket
    const p = g.players[a]; const sid = "re" + round;
    const res = g.hub.handle(sid, "room:reconnect", { code: g.code, playerId: p.id, token: p.token });
    assert(res.ok, res.message);
    mine[a].forEach((id) => assert(res.state.myEvidence.some((e) => e.id === id)));
    g.ids[a] = sid; // continue using the new socket
  }
});

test("select / lock / unlock / reveal / win flow", () => {
  const g = setup(3); startGame(g); const [a, b] = detIdx(g);
  g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [g.room.ghostHand[0]] });
  assert(!g.call(a, "detective:select", { position: 1 }).ok, "cannot select during distribution");
  g.call(0, "ghost:end-clues");
  assert(!g.call(0, "detective:select", { position: 1 }).ok, "ghost cannot select");
  const pos = (i) => g.room.board.findIndex((s) => s.id === g.room.players[i].killerId) + 1;
  assert(!g.call(a, "detective:lock").ok, "cannot lock without selection");
  assert(!g.call(a, "detective:select", { position: 0 }).ok);
  assert(!g.call(a, "detective:select", { position: 10 }).ok);
  g.call(a, "detective:select", { position: pos(a) }); g.call(a, "detective:lock");
  assert(!g.call(a, "detective:select", { position: 1 }).ok, "locked");
  assert(g.call(a, "detective:unlock").ok);
  assert(g.call(a, "detective:select", { position: pos(a) }).ok, "can change after unlock");
  g.call(a, "detective:lock");
  g.call(b, "detective:select", { position: pos(b) }); g.call(b, "detective:lock");
  assert.strictEqual(g.room.phase, "reveal");
  assert(g.st(1).reveal.results.every((x) => x.correct));
  assert(g.st(1).reveal.final);
  assert(!g.call(a, "game:next-round").ok, "only host");
  assert(g.call(0, "game:next-round").ok);
  assert.strictEqual(g.room.phase, "finished");
  assert.strictEqual(g.room.result.winner, "detectives");
});

test("ghost wins after the last round; solved detectives are excluded; eliminated suspect blocked", () => {
  const g = setup(3, { rounds: 2 }); startGame(g); const [a, b] = detIdx(g);
  const pos = (i) => g.room.board.findIndex((s) => s.id === g.room.players[i].killerId) + 1;
  const wrongFor = (i) => g.room.board.findIndex((s) => s.id !== g.room.players[i].killerId && s.id !== g.room.players[b].killerId && s.id !== g.room.players[a].killerId) + 1;
  g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [g.room.ghostHand[0]] }); g.call(0, "ghost:end-clues");
  g.call(a, "detective:select", { position: pos(a) }); g.call(a, "detective:lock");
  g.call(b, "detective:select", { position: wrongFor(b) }); g.call(b, "detective:lock");
  assert(g.room.players[a].solved && !g.room.players[b].solved);
  assert(!g.st(1).reveal.final);
  g.call(0, "game:next-round");
  assert.strictEqual(g.room.round, 2);
  assert(!g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [g.room.ghostHand[0]] }).ok, "cannot give to solved detective");
  g.call(0, "ghost:give", { targetId: g.players[b].id, cardIds: [g.room.ghostHand[0]] }); g.call(0, "ghost:end-clues");
  assert(!g.call(b, "detective:select", { position: pos(a) }).ok, "cleared suspect cannot be chosen");
  assert(!g.call(a, "detective:select", { position: 1 }).ok, "solved detective cannot select");
  g.call(b, "detective:select", { position: wrongFor(b) }); g.call(b, "detective:lock");
  assert(g.room.reveal.final);
  g.call(0, "game:next-round");
  assert.strictEqual(g.room.phase, "finished");
  assert.strictEqual(g.room.result.winner, "ghost");
  assert(g.call(0, "game:rematch").ok);
  assert.strictEqual(g.room.phase, "lobby");
  assert(g.room.players.every((p) => p.evidence.length === 0));
});

test("disconnect pauses, reconnect resumes, host can drop an absent detective", () => {
  const g = setup(4); startGame(g); const [a, b, c] = detIdx(g);
  g.hub.disconnect(g.ids[b]);
  assert(g.room.paused);
  assert(!g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [g.room.ghostHand[0]] }).ok);
  assert(!g.call(0, "game:drop", { playerId: g.players[a].id }).ok, "connected player cannot be dropped");
  assert(g.call(0, "game:drop", { playerId: g.players[b].id }).ok);
  assert(!g.room.paused);
  assert(!g.call(0, "ghost:give", { targetId: g.players[b].id, cardIds: [g.room.ghostHand[0]] }).ok);
  g.call(0, "ghost:give", { targetId: g.players[a].id, cardIds: [g.room.ghostHand[0]] }); g.call(0, "ghost:end-clues");
  const wrong = (i) => g.room.board.findIndex((s) => s.id !== g.room.players[i].killerId) + 1;
  g.call(a, "detective:select", { position: wrong(a) }); g.call(a, "detective:lock");
  g.call(c, "detective:select", { position: wrong(c) }); g.call(c, "detective:lock");
  assert.strictEqual(g.room.phase, "reveal", "dropped player must not block the reveal");
  // reconnect with a valid token
  g.hub.disconnect(g.ids[c]); assert(g.room.paused);
  assert(g.hub.handle("x", "room:reconnect", { code: g.code, playerId: g.players[c].id, token: g.players[c].token }).ok);
  assert(!g.room.paused);
  assert(!g.hub.handle("y", "room:reconnect", { code: g.code, playerId: g.players[c].id, token: "bad" }).ok);
  assert(!g.hub.handle("z", "room:reconnect", { code: g.code, playerId: g.players[b].id, token: g.players[b].token }).ok, "dropped player can't return");
});

test("creating a new room from a socket detaches it from the old one", () => {
  const g = setup(2); const r = g.hub.handle(g.ids[1], "room:create", { name: "X" });
  assert(r.ok && r.code !== g.code);
  assert.strictEqual(g.room.players[1].connected, false);
});

test("lobby rules: needs ghost, 2+ players, random ghost, duplicate names, kick, full room", () => {
  const g = setup(2);
  assert(!g.call(0, "game:start").ok, "needs ghost");
  assert(!g.call(1, "room:configure", { rounds: 2 }).ok, "only host configures");
  assert(g.call(0, "room:configure", { ghostId: "random" }).ok);
  assert(g.call(0, "game:start").ok);
  assert.strictEqual(g.room.players.filter((p) => p.role === "ghost").length, 1);
  assert(!g.hub.handle("late", "room:join", { name: "L", code: g.code }).ok, "game started");
  const h = setup(1); assert(!h.call(0, "game:start").ok);
  const dup = setup(3); assert.strictEqual(new Set(dup.room.players.map((p) => p.name)).size, 3);
  const full = setup(6); assert(!full.hub.handle("s9", "room:join", { name: "7", code: full.code }).ok);
  const k = setup(3); assert(k.call(0, "room:kick", { playerId: k.players[2].id }).ok); assert.strictEqual(k.room.players.length, 2);
  assert(!k.call(0, "room:kick", { playerId: k.players[0].id }).ok);
});

test("fuzz: invariants hold over 300 random games", () => {
  for (let n = 0; n < 300; n++) {
    const g = setup(2 + (n % 5), { rounds: 1 + (n % 6), shuffleLimit: n % 6 }); startGame(g, n % g.players.length);
    const gi = g.room.players.findIndex((p) => p.role === "ghost");
    let guard = 0;
    while (g.room.phase !== "finished" && guard++ < 200) {
      const dets = detIdx(g).filter((i) => !g.room.players[i].solved);
      if (g.room.phase === "distribute") {
        const ops = Math.floor(Math.random() * 4);
        for (let k = 0; k < ops; k++) {
          const roll = Math.random();
          if (roll < 0.6 && g.room.ghostHand.length) {
            const cnt = 1 + Math.floor(Math.random() * g.room.ghostHand.length);
            g.call(gi, "ghost:give", { targetId: g.players[dets[Math.floor(Math.random() * dets.length)]].id, cardIds: g.room.ghostHand.slice(0, cnt) });
          } else g.call(gi, "ghost:shuffle");
          deckConservation(g);
        }
        if (g.room.givenThisRound < 1) g.call(gi, "ghost:give", { targetId: g.players[dets[0]].id, cardIds: [g.room.ghostHand[0]] });
        const before = g.room.players.map((p) => p.evidence.length);
        assert(g.call(gi, "ghost:end-clues").ok);
        assert.deepStrictEqual(g.room.players.map((p) => p.evidence.length), before);
      } else if (g.room.phase === "select") {
        for (const i of dets) {
          const cleared = g.room.players.filter((p) => p.solved).map((p) => p.killerId);
          const options = g.room.board.map((s, k) => [s, k + 1]).filter(([s]) => !cleared.includes(s.id));
          const [s, pos] = Math.random() < 0.5 ? options.find(([x]) => x.id === g.room.players[i].killerId) : options[Math.floor(Math.random() * options.length)];
          assert(g.call(i, "detective:select", { position: pos }).ok);
          assert(g.call(i, "detective:lock").ok);
        }
        assert.strictEqual(g.room.phase, "reveal");
      } else if (g.room.phase === "reveal") assert(g.call(0, "game:next-round").ok);
    }
    assert.strictEqual(g.room.phase, "finished", "game must always terminate");
  }
});


const matches = require(path.join(__dirname, "..", "public", "data", "matches.json"));

test("suspect id beats a stale position number (lock-in bug)", () => {
  const g = setup(3); startGame(g, 0);
  const i = detIdx(g)[0];
  assert(g.call(0, "ghost:give", { targetId: g.room.players[i].id, cardIds: [g.room.ghostHand[0]] }).ok);
  assert(g.call(0, "ghost:end-clues").ok);
  const target = g.room.board[4];
  assert(g.call(i, "detective:select", { position: 1, suspectId: target.id }).ok); // client thinks it is #1, but tapped suspect is #5
  assert.strictEqual(g.room.players[i].selection, 5);
  assert(g.call(i, "detective:lock").ok);
  assert(g.call(i, "detective:unlock").ok);
  assert(g.call(i, "detective:select", { position: 2 }).ok); // old clients without suspectId still work
  assert.strictEqual(g.room.players[i].selection, 2);
});

test("balanced hands: >=2 useful, <=1 fits-nobody, <=1 fits-everybody", () => {
  let hands = 0;
  for (let n = 0; n < 300; n++) {
    const hub = createHub({ evidence, suspects, matches, send: () => {} });
    const a = hub.handle("a", "room:create", { name: "A" });
    hub.handle("b", "room:join", { name: "B", code: a.code });
    hub.handle("c", "room:join", { name: "C", code: a.code });
    const room = hub.rooms.get(a.code);
    hub.handle("a", "room:configure", { ghostId: room.players[0].id });
    assert(hub.handle("a", "game:start").ok);
    const board = new Set(room.board.map((x) => x.id));
    const killers = new Set(room.players.filter((p) => p.role === "detective").map((p) => p.killerId));
    for (let k = 0; k < 3; k++) {
      const hand = room.ghostHand;
      assert.strictEqual(hand.length, HAND_SIZE);
      const fit = (id) => (matches.omni.includes(id) ? 9 : (matches.cards[id] || []).filter((x) => board.has(x)).length);
      assert(hand.filter((id) => fit(id) > 0 && fit(id) < 6 && (matches.cards[id] || []).some((x) => killers.has(x))).length >= 2, "needs 2 useful cards");
      assert(hand.filter((id) => fit(id) === 0).length <= 1, "too many dead cards");
      assert(hand.filter((id) => fit(id) >= 6).length <= 1, "too many omni cards");
      hands++;
      if (k < 2) assert(hub.handle("a", "ghost:shuffle").ok);
    }
  }
  assert.strictEqual(hands, 900);
});

console.log(`\n${passed} test groups passed`);
