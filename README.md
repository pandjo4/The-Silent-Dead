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

## Adding suspects and evidence
1. Put the picture in `public/assets/suspects/` or `public/assets/evidence/` (file names are case-sensitive on Render).
2. Add the entry to `public/data/suspects.json` / `evidence.json`. An entry whose picture is missing is skipped (see the server log), so the game never shows a broken card.
3. Add the card to `public/data/matches.json` (`"card-id": ["suspect-id", ...]` = suspects whose portrait visibly contains that object). It is used to deal playable hands: at least 2 cards that fit a real culprit, at most 1 that fits nobody and at most 1 that fits almost everybody. The server logs a warning for unknown ids or cards without an entry.
