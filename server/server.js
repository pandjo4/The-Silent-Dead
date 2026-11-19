const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createHub } = require("./hub");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const PLACEHOLDER = "assets/evidence/placeholder.svg";
const isProd = process.env.NODE_ENV === "production";

/** Load a card database. Broken entries are skipped / repaired instead of crashing the whole server. */
function loadDatabase(file, label) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${label} database must be a JSON array.`);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) { console.warn(`[${label}] skipped an entry without an id`); continue; }
    if (seen.has(item.id)) { console.warn(`[${label}] skipped duplicate id: ${item.id}`); continue; }
    seen.add(item.id);
    const entry = { ...item, name: typeof item.name === "string" && item.name.trim() ? item.name : item.id };
    const rel = typeof item.image === "string" ? item.image.replace(/^\/+/, "") : "";
    const abs = path.resolve(PUBLIC_DIR, rel);
    if (!rel || !abs.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(abs)) {
      console.warn(`[${label}] image missing for "${item.id}" (${item.image}) - using placeholder`);
      entry.image = PLACEHOLDER;
    } else entry.image = rel;
    out.push(entry);
  }
  return out;
}

const suspects = loadDatabase("suspects.json", "Suspects");
const evidence = loadDatabase("evidence.json", "Evidence");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

const hub = createHub({
  suspects,
  evidence,
  uid: () => crypto.randomBytes(16).toString("hex"),
  random: () => crypto.randomInt(0, 2 ** 30) / 2 ** 30,
  send: (socketId, event, data) => io.to(socketId).emit(event, data),
  disconnect: (socketId) => io.sockets.sockets.get(socketId)?.disconnect(true),
  log: (e) => console.error(e),
});

app.disable("x-powered-by");
app.use("/assets", express.static(path.join(PUBLIC_DIR, "assets"), { maxAge: isProd ? "1d" : 0, etag: true }));
app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: 0, etag: true }));
app.get("/health", (_, res) => res.json({ ok: true, rooms: hub.rooms.size }));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/socket.io/")) return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const EVENTS = [
  "room:create", "room:join", "room:reconnect", "room:configure", "room:kick", "room:close",
  "game:start", "game:next-round", "game:drop", "game:rematch",
  "ghost:give", "ghost:end-clues", "ghost:shuffle",
  "detective:select", "detective:lock", "detective:unlock",
];

io.on("connection", (socket) => {
  for (const event of EVENTS) {
    socket.on(event, (payload, ack) => {
      if (typeof payload === "function") { ack = payload; payload = {}; }
      const res = hub.handle(socket.id, event, payload);
      if (typeof ack === "function") ack(res);
    });
  }
  socket.on("disconnect", () => hub.disconnect(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`THE SILENT DEAD server listening on ${PORT} (${suspects.length} suspects, ${evidence.length} evidence cards)`));
