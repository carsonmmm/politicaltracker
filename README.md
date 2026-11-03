# Midterm Live

Live tracker for the November 3, 2026 U.S. midterms: vote counts, Kalshi and Polymarket odds, balance of power, and race context. Every number carries `source`, `source_url` and `fetched_at`. Nothing is estimated or made up; missing data shows "Not available" and the reason.

## Try it in your browser (GitHub Codespaces)

1. On the repo page, switch to branch `claude/friendly-feynman-bbl0xw`, then **Code → Codespaces → Create codespace**.
2. Wait for setup. The app starts by itself (`npm start`) and opens on port 8080 with **real** Kalshi and Polymarket data.
3. The Admin password is printed in the terminal, unless you set an `ADMIN_TOKEN` Codespaces secret.
4. To see every screen filled with **fake** data, open a second terminal and run `npm run demo`, then open port 8081 from the **Ports** tab (password `demo`).

Forwarded ports are private to your GitHub login by default. Personal accounts get a free monthly allowance of Codespaces hours. Stop the codespace when you're done.

## Run it

```bash
npm install
ADMIN_TOKEN=pick-a-secret npm start      # http://localhost:8080
npm run probe                            # which data sources this machine can reach
npm test
npm run demo                             # fake data on http://localhost:8081 (password: demo)
```

Needs Node 20 or newer. The two runtime dependencies are the map shapes (`us-atlas`, `topojson-client`).

### Optional keys (environment variables)

| Variable | What it turns on |
|---|---|
| `AP_API_KEY` | AP Elections API: live vote counts and AP race calls (paid) |
| `FEC_API_KEY` | OpenFEC campaign finance: full donor and outside-spending detail (free from api.data.gov; without it, `DEMO_KEY` gives summaries only) |
| `CONGRESS_API_KEY` | Congress.gov, Phase 4 (free api.data.gov key) |
| `ADMIN_TOKEN` | Fixed admin password (otherwise a random one is printed at startup) |
| `PORT`, `DATA_DIR` | Port (8080) and where runtime data is kept (`data/runtime/`) |
| `LOW_VOLUME_USD`, `LOW_VOLUME_CONTRACTS` | Markets below these volumes are flagged as unreliable (50,000 each) |

## How it works

```
 Kalshi ─┐                      ┌─ /api/state  (dashboard, lists)
 Polymarket ─┤  adapters  ──►  engine  ──┤  /api/race/:id
 AP / DDHQ ─┤  (one per source,  (merge, tiers,  ├─ /api/events (SSE push)
 Results file ─┤   shared format)  history, calls) └─ /api/admin/* (manual entry)
 Manual (admin) ─┘
```

* **Server-side fetching.** A small Node server polls every source, so browser CORS rules never block the app.
* **Adapters** (`server/adapters/`) turn each source into one shared format (see `docs/DATA.md`). Swapping a free source for a paid one only means writing a new adapter.
* **Results priority:** Manual > AP > Decision Desk HQ > state office > research file. When two sources disagree, the race page shows both.
* **Refresh:** odds every 60 s and results every 45 s on election night (Nov 3–5), then every 15 min and 10 min. Data older than 1.5× its interval is labelled **Stale**.
* **Fallbacks:** the last odds and results snapshot is saved to disk and shown, labelled stale, if a feed goes down.
* **History:** every odds and vote-count change is appended to `data/runtime/history/*.jsonl` for trend lines. Odds from before the server started are backfilled from Kalshi candlesticks and Polymarket price history.
* **Tiers:** Tier 1 if any entered rating is Toss-up/Lean/Tilt or the market average is 15–85%. Tier 2 if rated Likely. A race moves up to Tier 1 on the night if the margin is under 5 points with at least 25% of the expected vote counted.

## Simulator (`#/sim`)

* **Scenario builder:** click a state on the map (no pick → D → R) or use the D/R/Oth buttons on the race list. Called races are locked, and a call overrides any pick you made.
* **Path to majority:** the smallest number of open races each party needs, listing the ones where markets give that party the best chance.
* **Monte Carlo:** 10,000 runs from market odds. The *shared national swing* slider sets how strongly races move together (a Gaussian copula, so each race still wins at its market chance on average). The *what-if tilt* moves every race toward one party, and is labelled as your assumption. Races with no market are left undecided, and the app reports "depends on N unpriced races" instead of guessing, unless you choose to treat them as 50/50.
* **Save and share:** the scenario is encoded in the URL (`#/sim?c=S&a=S-GA.D,...`), so **Copy share link** sends it to anyone. **Save** keeps named scenarios in your browser. The math is in `public/js/sim.js`, tested in `test/sim.test.js`.

## Candidates and money (Phase 3)

* **Candidate pages** (`#/candidate/<race>/<name>`) cover biography, political history, the same ten policy issues for everyone, endorsements and campaign finance. Voting records and personal disclosures arrive in Phase 4.
* **Race pages** add a head-to-head table of issues, a finance comparison, outside spending for and against each candidate (top spenders named), and a key-moments timeline.
* **Finance** comes from OpenFEC for Tier 1 Senate and House races (see `docs/DATA.md`). The FEC lists everyone who filed, so the app links filers to the race's known candidates by last name and party, or by an FEC ID set in Admin. Everyone else appears under "Other FEC filers". Governor finance is reported to the states and shows as Not available.
* **Profiles** come from `data/candidates-research.json` (ships empty) and Admin → Candidate profile.

## Files you edit

| File | Purpose | Ships as |
|---|---|---|
| `data/results-research.json` | Fallback results refreshed by research (see `docs/DATA.md`) | empty |
| `data/candidates-research.json` | Candidate profiles and key moments | empty |
| `config/ratings.json` | Dated expert ratings | empty |
| `config/market-map.json` | Force a market onto a race, or ignore it | empty |
| `config/chamber.json` | Seats not up in 2026 | **unverified**, builder-compiled |
| `config/poll-closing.json` | Poll closing times (ET) | **unverified**, builder-compiled |
| `config/race-formats.json` | Ranked-choice, top-two and runoff rules | **unverified**, builder-compiled |

Everything can also be entered or corrected in the **Admin** page, where entries are labelled Manual.

## Deploy (so you can open it from a phone)

* **Render:** push this repo, then New → Blueprint and pick it. `render.yaml` sets up the service, a health check and a 1 GB disk for history. Set `ADMIN_TOKEN` (and `FEC_API_KEY`, `AP_API_KEY` if you have them) in the dashboard.
* **Any Docker host** (Fly.io, Railway, a VPS): `docker build -t midterm-live . && docker run -p 8080:8080 -v midterm-data:/data -e ADMIN_TOKEN=... midterm-live`
* Keep `/data` on a persistent volume, or odds history, snapshots and manual entries are lost on redeploy.
* Health check: `GET /healthz`.

## Testing without network access

`test/mock-upstream.js` is a fake Kalshi/Polymarket/AP server with obviously fake candidates ("Test Candidate-A"). It exists only to exercise the pipeline:

```bash
node test/mock-upstream.js &
DATA_DIR=/tmp/mock KALSHI_BASE=http://localhost:9090/kalshi POLYMARKET_BASE=http://localhost:9090/poly \
POLYMARKET_CLOB=http://localhost:9090/clob AP_BASE=http://localhost:9090/ap AP_API_KEY=fake \
FEC_BASE=http://localhost:9090/fec FEC_API_KEY=fake npm start
```

Never point a real deployment at it.
