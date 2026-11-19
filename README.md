# THE SILENT DEAD

Real-time cooperative mystery game (inspired by Mysterium Park). One player is the Ghost and sends visual evidence; the others are Detectives who must find their own hidden culprit.

## How a round works
1. **Clues** – the Ghost holds **6 evidence cards**. They can give 1–6 of them to any detectives (e.g. 1 to player A, 1 to player B, 4 to player C). Then the Ghost either
   - presses **End giving clues** (with an "Are you sure?" confirmation: *Yes* → detectives guess, *No* → back to giving clues), or
   - presses **Shuffle**: every card that was **not given** goes back into the deck and 6 new random cards are drawn (limited per game, set in the lobby).
2. **Guess** – each detective picks a suspect and locks in (can be changed until everyone has locked in).
3. **Reveal** – results are shown; the host starts the next round or the final screen.

Cards given to a detective stay in that detective's case file for the whole game.

## Deploy on Render
Push this folder to GitHub → Render → New + → Blueprint (uses `render.yaml`). Or a Web Service with Build `cd server && npm install`, Start `cd server && npm start`, Health check `/health`.

## Local run
```bash
cd server && npm install && npm start   # http://localhost:3000
```

## Tests (no install needed)
```bash
node tests/hub.test.js   # game rules, 300 random games
node tests/e2e.js        # real-browser test with 3 players (needs playwright)
```

## Structure
- `server/hub.js` – all game rules (pure, testable) · `server/server.js` – Express + Socket.IO transport
- `public/` – UI (`app.js`, `style.css`, `index.html`), `data/*.json`, `assets/`
