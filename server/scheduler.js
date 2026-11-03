// Polling loops. Each feed runs on its own timer and reports health to the engine.
import { createKalshiAdapter, kalshiHistory } from './adapters/kalshi.js';
import { createPolymarketAdapter, polymarketHistory } from './adapters/polymarket.js';
import { createApAdapter, createDdhqAdapter, createFileAdapter } from './adapters/results.js';
import { intervals } from './engine.js';
import { store } from './store.js';
import { mapLimit, nowIso } from './lib/util.js';
import { createFecAdapter, hasRealKey } from './adapters/fec.js';
import { lastName } from './lib/match.js';
import { fecLastName } from './adapters/fec.js';

const HISTORY_START = Date.parse(process.env.HISTORY_START || '2026-09-01T00:00:00Z');

export function startScheduler(engine, { fetchImpl } = {}) {
  const marketMap = () => engine.marketMap();
  let kalshi = createKalshiAdapter({ fetchImpl, marketMap: marketMap() });
  let poly = createPolymarketAdapter({ fetchImpl, marketMap: marketMap() });
  const resultFeeds = [createApAdapter({ fetchImpl }), createDdhqAdapter(), createFileAdapter()];
  const backfilled = new Set(store.load('backfilled.json', []));
  const timers = [];

  const loop = (name, fn, every) => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const started = Date.now();
      try {
        await fn();
      } catch (err) {
        engine.feedError(name, err, { interval_ms: every() });
        engine.bump(`${name}-error`);
      }
      const wait = Math.max(5_000, every() - (Date.now() - started));
      const t = setTimeout(tick, wait);
      timers.push(t);
    };
    tick();
    return () => (stopped = true);
  };

  loop('Kalshi', async () => {
    const { records, errors } = await kalshi.refresh();
    engine.ingestOdds('Kalshi', records);
    engine.unmatched.Kalshi = kalshi.getUnmatched();
    engine.feedOk('Kalshi', { interval_ms: intervals().odds, markets: records.length, partial_errors: errors.slice(0, 3) });
    engine.bump('odds');
    backfillKalshi(records).catch(() => {});
  }, () => intervals().odds);

  loop('Kalshi discovery', async () => {
    kalshi = createKalshiAdapter({ fetchImpl, marketMap: marketMap() });
    const r = await kalshi.discover();
    engine.unmatched.Kalshi = kalshi.getUnmatched();
    engine.feedOk('Kalshi discovery', { interval_ms: intervals().discover, ...r });
  }, () => intervals().discover);

  loop('Polymarket', async () => {
    poly = createPolymarketAdapter({ fetchImpl, marketMap: marketMap() });
    const { records } = await poly.refresh();
    engine.ingestOdds('Polymarket', records);
    engine.unmatched.Polymarket = poly.getUnmatched();
    engine.feedOk('Polymarket', { interval_ms: intervals().odds, markets: records.length });
    engine.bump('odds');
    backfillPoly(records).catch(() => {});
  }, () => intervals().odds);

  for (const feed of resultFeeds) {
    loop(feed.source, async () => {
      const { records, errors } = await feed.refresh();
      engine.ingestResults(feed.source, records);
      engine.feedOk(feed.source, { interval_ms: intervals().results, records: records.length, partial_errors: errors.slice(0, 5), configured: feed.configured });
      engine.bump('results');
    }, () => (feed.source === 'Results file' ? 15_000 : intervals().results));
  }
  // Candidate research file: re-read every 30 s so edits show up without a restart.
  loop('Candidate research file', async () => {
    engine.reloadResearch();
    engine.feedOk('Candidate research file', { interval_ms: 30_000, records: engine.research.profiles.length, partial_errors: engine.research.errors.slice(0, 5) });
  }, () => 30_000);

  // Campaign finance: Tier 1 Senate/House races, once a day, rate-limited.
  const fec = createFecAdapter({ fetchImpl });
  let financeRunning = false;
  let financeWarm = false; // poll every 30 s until odds have loaded and Tier 1 exists
  loop('OpenFEC', async () => {
    if (financeRunning) return;
    financeRunning = true;
    try {
      const n = await refreshFinance(engine, fec);
      if (n > 0 || Object.keys(engine.finance).length) financeWarm = true;
      engine.feedOk('OpenFEC', { interval_ms: FINANCE_EVERY, races_refreshed: n, races_cached: Object.keys(engine.finance).length, key: hasRealKey() ? 'FEC_API_KEY' : 'DEMO_KEY (summaries only; set FEC_API_KEY for donor detail)', calls: fec.calls() });
    } catch (err) {
      financeWarm = true; // feed down: back off to the normal 10-minute check
      throw err;
    } finally {
      financeRunning = false;
    }
  }, () => (financeWarm ? FINANCE_EVERY : 30_000));

  // Manual entries are loaded once at start and re-merged on every edit.
  engine.ingestResults('Manual', Object.values(engine.manual.results));
  engine.feedOk('Manual', { interval_ms: null });

  async function backfillKalshi(records) {
    const todo = records.flatMap((r) => r.outcomes.map((o) => ({ r, o }))).filter(({ o }) => !backfilled.has(`k:${o.market_id}`));
    await mapLimit(todo.slice(0, 40), 2, async ({ r, o }) => {
      const pts = await kalshiHistory({ seriesTicker: r.series_ticker, marketTicker: o.market_id, startTs: Math.floor(HISTORY_START / 1000), endTs: Math.floor(Date.now() / 1000), fetchImpl });
      engine.ingestOddsHistory(pts.map((p) => ({ ...p, raceId: r.raceId, source: 'Kalshi', market_id: o.market_id, label: o.label, party: o.party, backfill: true })));
      backfilled.add(`k:${o.market_id}`);
    });
    store.save('backfilled.json', [...backfilled]);
  }
  async function backfillPoly(records) {
    const todo = records.flatMap((r) => r.outcomes.map((o) => ({ r, o }))).filter(({ o }) => o.token_id && !backfilled.has(`p:${o.token_id}`));
    await mapLimit(todo.slice(0, 40), 2, async ({ r, o }) => {
      const pts = await polymarketHistory({ tokenId: o.token_id, fetchImpl });
      engine.ingestOddsHistory(pts.filter((p) => Date.parse(p.t) >= HISTORY_START).map((p) => ({ ...p, raceId: r.raceId, source: 'Polymarket', market_id: o.market_id, label: o.label, party: o.party, backfill: true })));
      backfilled.add(`p:${o.token_id}`);
    });
    store.save('backfilled.json', [...backfilled]);
  }

  return { stop: () => timers.forEach(clearTimeout) };
}

const FINANCE_EVERY = 10 * 60_000; // checks every 10 min for Tier 1 races whose data is over a day old (or new to Tier 1)

export async function refreshFinance(engine, fec, { maxAgeMs = 24 * 3600_000 } = {}) {
  const races = engine.state().races
    .filter((r) => r.tier === 1 && (r.office === 'S' || r.office === 'H'))
    .filter((r) => !engine.finance[r.id] || Date.now() - Date.parse(engine.finance[r.id].fetched_at) > maxAgeMs || engine.finance[r.id].error);
  let done = 0;
  let lastErr = null;
  for (const r of races) {
    const race = engine.byId.get(r.id);
    const rec = { fetched_at: nowIso(), level: 'summary', candidates: [], source_url: `https://www.fec.gov/data/elections/${race.office === 'S' ? 'senate' : 'house'}/${race.state.toLowerCase()}/${race.office === 'H' ? `${String(race.district).padStart(2, '0')}/` : ''}2026/` };
    try {
      rec.candidates = await fec.raceSummary(race);
      if (hasRealKey()) {
        // Detail for the race's known candidates, or the top two fundraisers if none are known yet.
        const known = engine.candidatesFor(r.id, engine.primaryResult(r.id));
        const targets = known.length
          ? rec.candidates.filter((c) => known.some((k) => fecLastName(c.fec_name) === lastName(k.name).replace(/[^a-z-]/g, '')))
          : rec.candidates.slice(0, 2);
        for (const t of targets.slice(0, 4)) {
          const i = rec.candidates.indexOf(t);
          try { rec.candidates[i] = await fec.candidateDetail(t, race.state); }
          catch (err) { rec.error = `detail for ${t.name}: ${err.message}`; }
        }
        rec.level = 'full';
      }
    } catch (err) {
      rec.error = err.message;
      lastErr = err;
    }
    const prev = engine.finance[r.id];
    // On failure keep the last good copy with its original fetched_at, so it is labelled stale correctly.
    engine.finance[r.id] = rec.error && !rec.candidates.length && prev?.candidates?.length ? { ...prev, error: rec.error, last_attempt: rec.fetched_at } : rec;
    store.save('finance.json', engine.finance);
    engine.bump('finance');
    done++;
    if (lastErr && done === 1 && !rec.candidates.length) throw lastErr;
    lastErr = null; // feed is down; stop this pass
  }
  return done;
}
