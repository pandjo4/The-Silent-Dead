// End-to-end browser test WITHOUT needing express/socket.io installed.
// A static server serves /public, a tiny fake socket.io client is injected, and every page talks to
// the real game hub (server/hub.js) running in this Node process.
// Usage: node tests/e2e.js [outDir]     (needs playwright; uses chromium)
const http = require("http"), fs = require("fs"), path = require("path"), assert = require("assert");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }
const { createHub } = require("../server/hub");

const PUB = path.join(__dirname, "..", "public");
const OUT = process.argv[2] || path.join(__dirname, "shots");
fs.mkdirSync(OUT, { recursive: true });
const evidence = JSON.parse(fs.readFileSync(path.join(PUB, "data/evidence.json"), "utf8"));
const suspects = JSON.parse(fs.readFileSync(path.join(PUB, "data/suspects.json"), "utf8"));

const MOCK_IO = `(function(){
 window.io=function(){
  const s={connected:false,_h:{},
   on(ev,fn){(this._h[ev]=this._h[ev]||[]).push(fn);return this},
   off(ev,fn){this._h[ev]=(this._h[ev]||[]).filter(f=>f!==fn);return this},
   emit(ev,payload,ack){window.__hubCall(ev,payload).then(r=>{if(typeof ack==='function')ack(r)})},
   connect(){setTimeout(()=>{s.connected=true;s._fire('connect')},10)},
   _fire(ev,...a){(this._h[ev]||[]).slice().forEach(f=>f(...a))}};
  window.__sock=s;s.connect();return s;};
 window.__recv=(ev,d)=>window.__sock._fire(ev,d);
 window.__drop=()=>{window.__sock.connected=false;window.__sock._fire('disconnect')};
 window.__up=()=>{window.__sock.connected=true;window.__sock._fire('connect')};
})();`;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/socket.io/socket.io.js") { res.setHeader("content-type", "text/javascript"); return res.end(MOCK_IO); }
  let f = path.join(PUB, url === "/" ? "index.html" : url);
  if (!f.startsWith(PUB) || !fs.existsSync(f)) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); res.end(fs.readFileSync(f));
});

const pages = new Map(); // sid -> page
const hub = createHub({
  evidence, suspects,
  send: (sid, ev, data) => { const p = pages.get(sid); if (p) p.evaluate(([e, d]) => window.__recv(e, d), [ev, data]).catch(() => {}); },
  disconnect: () => {},
});
let sidCounter = 0;
async function newPlayer(browser, viewport, label) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { if (!localStorage.getItem("__init")) localStorage.setItem("__init", "1"); });
  const page = await ctx.newPage();
  page.label = label; page.sid = "sock" + ++sidCounter; pages.set(page.sid, page);
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|fonts/.test(m.text())) page.errors.push(m.text()); });
  await page.exposeFunction("__hubCall", (ev, payload) => hub.handle(page.sid, ev, payload));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch();
  const DESK = { width: 1280, height: 900 }, MOB = { width: 390, height: 844 };
  const host = await newPlayer(browser, DESK, "host");
  const bea = await newPlayer(browser, DESK, "bea");
  const ghost = await newPlayer(browser, DESK, "ghost");
  const ok = (m) => console.log("  ok -", m);

  // ---- home + lobby
  await shot(host, "01-home");
  await host.fill("#playerName", "Ana"); await host.click("#createRoom");
  await host.waitForSelector("#lobbyScreen:not(.hidden)");
  const code = (await host.textContent("#lobbyCode")).trim();
  assert.match(code, /^[A-Z2-9]{5}$/);
  for (const [p, n] of [[bea, "Bea"], [ghost, "Gost"]]) { await p.fill("#playerName", n); await p.fill("#roomCode", code.toLowerCase()); await p.press("#roomCode", "Enter"); await p.waitForSelector("#lobbyScreen:not(.hidden)"); }
  await host.selectOption("#ghostSelect", { label: "Gost" });
  await host.click('#roundOptions [data-round="3"]');
  await host.waitForFunction(() => !document.getElementById("startGame").disabled);
  await shot(host, "02-lobby");
  ok("home, create, join with lowercase code, lobby");
  await host.click("#startGame");
  await ghost.waitForSelector("#gameScreen:not(.hidden)");
  await host.waitForSelector("#gameScreen:not(.hidden)");

  // ---- ghost distribution (multi give)
  assert.strictEqual(await ghost.locator("#ghostHand .evidence-card").count(), 6);
  const give = async (indices, target) => {
    for (const i of indices) await ghost.locator("#ghostHand .evidence-card").nth(i).click();
    await ghost.locator(`#targetList .target-btn`, { hasText: target }).click();
    await ghost.click("#giveBtn");
  };
  await shot(ghost, "03-ghost-hand");
  await give([0], "Ana");
  await host.waitForFunction(() => document.querySelectorAll("#myEvidence .evidence-display").length === 1);
  await give([0], "Bea");
  await bea.waitForFunction(() => document.querySelectorAll("#myEvidence .evidence-display").length === 1);
  await give([0, 1, 2], "Ana");
  await host.waitForFunction(() => document.querySelectorAll("#myEvidence .evidence-display").length === 4);
  assert.strictEqual(await ghost.locator("#ghostHand .evidence-card").count(), 1);
  ok("ghost gave 1 + 1 + 3 cards across two detectives; hand shrinks to 1");

  // mark DOM nodes & image elements to prove they are not recreated by later updates
  await host.evaluate(() => { document.querySelectorAll("#myEvidence .evidence-display, #myEvidence img").forEach((e) => (e.__mark = 1)); });
  await shot(host, "04-detective-evidence");

  // ---- shuffle
  await ghost.click("#shuffleBtn");
  await ghost.waitForSelector("#modal:not(.hidden)");
  await ghost.click("#modalNo");
  assert.strictEqual(await ghost.locator("#ghostHand .evidence-card").count(), 1, "cancel keeps hand");
  await ghost.click("#shuffleBtn"); await ghost.click("#modalYes");
  await ghost.waitForFunction(() => document.querySelectorAll("#ghostHand .evidence-card").length === 6);
  assert.strictEqual(await host.locator("#myEvidence .evidence-display").count(), 4, "detective cards survive a shuffle");
  assert.match(await ghost.textContent("#shuffleCount"), /2 LEFT/);
  ok("shuffle confirm: No keeps hand, Yes draws 6 new cards, detective cards intact");
  await give([0, 1, 2, 3], "Bea");
  await bea.waitForFunction(() => document.querySelectorAll("#myEvidence .evidence-display").length === 5);

  // ---- end clues confirmation
  await ghost.click("#endCluesBtn"); await ghost.waitForSelector("#modal:not(.hidden)");
  await shot(ghost, "05-confirm-end");
  await ghost.click("#modalNo");
  assert.match(await ghost.textContent("#phaseEyebrow"), /GHOST LEAVES SIGNS/, "No returns to giving clues");
  await ghost.click("#endCluesBtn"); await ghost.click("#modalYes");
  await host.waitForSelector("#dock:not(.hidden)");
  ok("End giving clues -> Are you sure? No returns, Yes starts guessing");

  // ---- evidence nodes were not rebuilt by the phase change (no flicker)
  const kept = await host.evaluate(() => [...document.querySelectorAll("#myEvidence .evidence-display")].filter((e) => e.__mark).length);
  assert.strictEqual(kept, 4, "existing evidence nodes must be reused");
  const keptImgs = await host.evaluate(() => [...document.querySelectorAll("#myEvidence img")].filter((e) => e.__mark).length);
  assert.strictEqual(keptImgs, 4, "existing evidence <img> must be reused");
  ok("evidence DOM + images are reused across updates (no flicker/vanishing)");

  // ---- guessing: every suspect can be clicked & locked
  await shot(host, "06-select-desktop");
  const state = hub.rooms.get(code);
  const idx = (name) => state.board.findIndex((s) => s.id === state.players.find((p) => p.name === name).killerId);
  for (let i = 0; i < 9; i++) {
    await host.locator("#suspectBoard .suspect-card").nth(i).click();
    await host.waitForFunction((n) => document.querySelectorAll("#suspectBoard .suspect-card")[n].classList.contains("selected"), i);
    assert.strictEqual(state.players.find((p) => p.name === "Ana").selection, i + 1);
  }
  ok("detective can select each of the 9 suspects");
  // click while the other detective's selection updates arrive (re-render between mousedown/up)
  const box = await host.locator("#suspectBoard .suspect-card").nth(4).boundingBox();
  await host.mouse.move(box.x + 20, box.y + 20); await host.mouse.down();
  await bea.locator("#suspectBoard .suspect-card").nth(2).click();
  await host.mouse.up();
  await host.waitForFunction(() => document.querySelectorAll("#suspectBoard .suspect-card")[4].classList.contains("selected"));
  ok("click still registers when another player's update arrives mid-click");

  await host.locator("#suspectBoard .suspect-card").nth(idx("Ana")).click();
  await host.click("#lockBtn");
  await host.waitForFunction(() => /CHANGE/.test(document.getElementById("lockBtn").textContent));
  await host.locator("#suspectBoard .suspect-card").nth(0).click(); // locked: should toast, not change
  assert.strictEqual(state.players.find((p) => p.name === "Ana").selection, idx("Ana") + 1);
  await host.click("#lockBtn"); // change choice
  await host.waitForFunction(() => /LOCK IN/.test(document.getElementById("lockBtn").textContent));
  await host.click("#lockBtn");
  // Bea guesses wrong on purpose
  const wrong = state.board.findIndex((s) => s.id !== state.players.find((p) => p.name === "Bea").killerId && s.id !== state.players.find((p) => p.name === "Ana").killerId);
  await bea.locator("#suspectBoard .suspect-card").nth(wrong).click(); await bea.click("#lockBtn");
  await host.waitForSelector("#revealArea:not(.hidden)");
  await shot(host, "07-reveal");
  assert.strictEqual(await host.locator("#revealArea .reveal-row.ok").count(), 1);
  assert.strictEqual(await host.locator("#revealArea .reveal-row.bad").count(), 1);
  ok("lock / unlock / change choice, reveal shows 1 correct + 1 wrong");

  // ---- round 2: solved detective becomes observer, Bea keeps cards
  await host.click("#nextRound");
  await ghost.waitForFunction(() => /ROUND|2 \/ 3/.test(document.getElementById("roundLabel").textContent) && document.querySelectorAll("#ghostHand .evidence-card").length === 6);
  await host.waitForSelector("#waitingPanel:not(.hidden)");
  assert.strictEqual(await host.locator("#obsEvidence .evidence-display").count(), 4, "solved detective keeps seeing cards");
  assert.strictEqual(await bea.locator("#myEvidence .evidence-display").count(), 5);
  assert.strictEqual(await ghost.locator("#targetList .target-btn").count(), 1, "only unsolved detectives are targets");
  assert.strictEqual(await ghost.locator("#targetList .target-btn.active").count(), 1, "single target is auto-selected");
  await ghost.locator("#ghostHand .evidence-card").nth(0).click(); await ghost.click("#giveBtn");
  await bea.waitForFunction(() => document.querySelectorAll("#myEvidence .evidence-display").length === 6);
  assert.strictEqual(await bea.locator("#myEvidence .evidence-display.is-new").count(), 1);
  ok("round 2: observer panel, auto-selected target, new-card badge");

  // ---- disconnect / reconnect keeps cards, host can see pause
  await bea.evaluate(() => window.__drop());
  hub.disconnect(bea.sid);
  await host.waitForSelector("#pauseBanner:not(.hidden)");
  await shot(host, "08-paused");
  assert.strictEqual(await host.locator("#dropList [data-drop]").count(), 1);
  pages.delete(bea.sid); bea.sid = "sock" + ++sidCounter; pages.set(bea.sid, bea);
  await bea.evaluate(() => window.__up());
  await bea.waitForFunction(() => document.querySelectorAll("#myEvidence .evidence-display").length === 6);
  await host.waitForSelector("#pauseBanner", { state: "hidden" });
  ok("disconnect pauses, reconnect restores all 6 cards and resumes");

  // ---- finish round 2 -> ghost's end -> final
  await ghost.click("#endCluesBtn"); await ghost.click("#modalYes");
  await bea.waitForSelector("#dock:not(.hidden)");
  const idxB = state.board.findIndex((s) => s.id === state.players.find((p) => p.name === "Bea").killerId);
  await bea.locator("#suspectBoard .suspect-card").nth(idxB).click(); await bea.click("#lockBtn");
  await host.waitForSelector("#revealArea:not(.hidden)");
  await host.click("#nextRound");
  await host.waitForSelector("#endScreen:not(.hidden)");
  await shot(host, "09-end");
  assert.match(await host.textContent("#endTitle"), /solved your case/);
  await host.click("#rematchBtn");
  await host.waitForSelector("#lobbyScreen:not(.hidden)");
  ok("final screen + rematch returns everyone to the lobby");

  // ---- mobile layouts
  const m = await newPlayer(browser, MOB, "mobile");
  await shot(m, "10-mobile-home");
  const m2 = await newPlayer(browser, MOB, "mobile2");
  await m.fill("#playerName", "Mia"); await m.click("#createRoom"); await m.waitForSelector("#lobbyScreen:not(.hidden)");
  const mcode = (await m.textContent("#lobbyCode")).trim();
  await m2.fill("#playerName", "Noa"); await m2.fill("#roomCode", mcode); await m2.click("#joinRoom"); await m2.waitForSelector("#lobbyScreen:not(.hidden)");
  await shot(m, "11-mobile-lobby");
  await m.selectOption("#ghostSelect", { label: "Mia" }); await m.waitForFunction(() => !document.getElementById("startGame").disabled); await m.click("#startGame");
  await m.waitForSelector("#gameScreen:not(.hidden)");
  await m.locator("#ghostHand .evidence-card").nth(0).click(); await m.locator("#ghostHand .evidence-card").nth(1).click();
  await shot(m, "12-mobile-ghost");
  await m.click("#giveBtn");
  await m2.waitForFunction(() => document.querySelectorAll("#myEvidence .evidence-display").length === 2);
  await shot(m2, "13-mobile-detective-wait");
  await m.click("#endCluesBtn"); await m.click("#modalYes");
  await m2.waitForSelector("#dock:not(.hidden)");
  await m2.locator("#suspectBoard .suspect-card").nth(3).click();
  await shot(m2, "14-mobile-select");
  const hscroll = await m2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(hscroll <= 1, "no horizontal scroll on mobile, got " + hscroll);
  ok("mobile layout renders, no horizontal overflow");

  // ---- no JS errors anywhere
  for (const p of pages.values()) assert.deepStrictEqual(p.errors, [], `${p.label} had page errors`);
  ok("no JavaScript errors in any page");
  await browser.close(); server.close();
  console.log("\nE2E PASSED. Screenshots in", OUT);
})().catch(async (e) => { console.error("\nE2E FAILED:", e.message); console.error(e.stack); process.exit(1); });
