# THE SILENT DEAD

A real-time, browser-based cooperative mystery game. One player is the Ghost and distributes visual evidence; the other players are Detectives who identify their own hidden culprit.

## Deploy directly to Render

1. Push this entire folder to a GitHub repository.
2. In Render, choose **New + → Blueprint** and connect that GitHub repository.
3. Render reads `render.yaml` and deploys the Node web service.
4. Open the generated `https://...onrender.com` URL. The game is served by the same Node service as the multiplayer server.
5. Share that URL with the other players. They create or join the same room code.

You can also create a Render **Web Service** manually:
- Root Directory: leave blank (repository root)
- Build Command: `cd server && npm install`
- Start Command: `cd server && npm start`
- Health Check Path: `/health`

The frontend is served from `public/` by Express. Socket.IO connects to the same origin automatically; there is no separate frontend host or hard-coded Render URL.

## Game settings

The room host selects the Ghost, the number of rounds (1–6), and how many times per game the Ghost may replace their complete hand (0–5). A game supports 2–6 players.

## Project structure

- `public/` — game interface, styles, images and JSON databases
- `public/data/evidence.json` — all 31 evidence image cards
- `public/data/suspects.json` — suspect database
- `server/` — Express + Socket.IO game server
- `render.yaml` — Render Blueprint configuration

## Local testing

```bash
cd server
npm install
npm start
```

Then open `http://localhost:3000`.
