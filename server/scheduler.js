// Polling loops. Each feed runs on its own timer and reports health to the engine.
import { createKalshiAdapter, kalshiHistory } from './adapters/kalshi.js';
import { createPolymarketAdapter, polymarketHistory } from './adapters/polymarket.js';
import { createApAdapter, createDdhqAdapter, createFileAdapter } from './adapters/results.js';
import { createStateSitesAdapter } from './adapters/state-sites.js';
import { intervals } from './engine.js';
import { store } from './store.js';
import { mapLimit, nowIso } from './lib/util.js';
import { createFecAdapter, hasRealKey } from './adapters/fec.js';
import { surnameMatches } from './adapters/fec.js';
import { createMitAdapter } from './adapters/mit.js';
import { createVoteviewAdapter, createCongressAdapter } from './adapters/voteview.js';
import { createHouseClerkAdapter, createSenateEfdAdapter } from './adapters/disclosures.js';

const HISTORY_START = Date.parse(process.env.HISTORY_START || '2026-09-01T00:00:00Z');

export function startScheduler(engine, { fetchImpl } = {}) {
  const marketMap = () => engine.marketMap();
  let kalshi = createKalshiAdapter({ fetchImpl, marketMap: marketMap() });
  let poly = createPolymarketAdapter({ fetchImpl, marketMap: marketMap() });
  const resultFeeds = [createApAdapter({ fetchImpl, measureLookup: (st, label, id) => engine.measureLookup(st, label, id) }), createDdhqAdapter(), createStateSitesAdapter({ fetchImpl }), createFileAdapter()];
  const backfilled = new Set(store.load('backfilled.json', []));
  const stops = [];

  const loop = (name, fn, every) => {
    let stopped = false;
    let handle = null; // only the pending timer is kept, so nothing accumulates
    stops.push(() => { stopped = true; clearTimeout(handle); });
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
      handle = setTimeout(tick, wait);
    };
    tick();
  };

  // One discovery at a time; the live adapter is only swapped once the new one has finished.
  let discovering = null;
  const runDiscovery = () => {
    discovering ||= (async () => {
      const next = createKalshiAdapter({ fetchImpl, marketMap: marketMap() });
      const r = await next.discover();
      kalshi = next;
      engine.unmatched.Kalshi = next.getUnmatched();
      engine.feedOk('Kalshi discovery', { interval_ms: intervals().discover, ...r });
      return r;
    })().finally(() => { discovering = null; });
    return discovering;
  };

  loop('Kalshi', async () => {
    if (!kalshi.getKnown().size) await runDiscovery();
    const { records, errors } = await kalshi.refresh();
    engine.ingestOdds('Kalshi', records);
    engine.unmatched.Kalshi = kalshi.getUnmatched();
    engine.feedOk('Kalshi', { interval_ms: intervals().odds, markets: records.length, partial_errors: errors.slice(0, 3) });
    engine.bump('odds');
    backfillKalshi(records).catch(() => {});
  }, () => intervals().odds);

  loop('Kalshi discovery', () => runDiscovery(), () => intervals().discover);

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

  // On-demand: a race page that has no finance yet asks for it; serve those quickly.
  loop('OpenFEC on demand', async () => {
    if (financeRunning || !engine.financeRequests.size) return;
    financeRunning = true;
    try {
      await refreshFinance(engine, fec, { only: true });
    } finally {
      financeRunning = false;
    }
  }, () => 15_000);

  // ---------- Phase 4 sources ----------
  const DAY = 24 * 3600_000;
  const age = (iso) => (iso ? Date.now() - Date.parse(iso) : Infinity);

  // MIT Election Lab past results: download once; retry every 6 h until it works.
  const mit = createMitAdapter({ fetchImpl });
  loop('MIT Election Lab', async () => {
    if (engine.past && !engine.pastError) return engine.feedOk('MIT Election Lab', { interval_ms: 6 * 3600_000, records: Object.keys(engine.past.races).length, note: 'Loaded once; delete data/runtime/past.json to reload' });
    const past = await mit.fetchAll();
    engine.past = past;
    store.save('past.json', past);
    engine.feedOk('MIT Election Lab', { interval_ms: 6 * 3600_000, records: Object.keys(past.races).length });
    engine.bump('past');
  }, () => 6 * 3600_000);

  // VoteView: weekly, or right away when the key-vote list changes.
  const vv = createVoteviewAdapter({ fetchImpl });
  let vvRunning = false;
  loop('VoteView', async () => {
    if (vvRunning) return;
    if (engine.voteview && !engine.voteviewStale && age(engine.voteview.fetched_at) < 7 * DAY) return engine.feedOk('VoteView', { interval_ms: 60_000, records: engine.voteview.members.length });
    vvRunning = true;
    try {
      const data = await vv.fetchAll(engine.keyVotes());
      engine.voteview = data;
      engine.voteviewStale = false;
      store.save('voteview.json', data);
      engine.feedOk('VoteView', { interval_ms: 60_000, records: data.members.length });
      engine.bump('voteview');
    } finally {
      vvRunning = false;
    }
  }, () => 60_000);

  // House Clerk disclosure index: weekly, this year and last.
  const clerk = createHouseClerkAdapter({ fetchImpl });
  loop('House Clerk disclosures', async () => {
    if (engine.houseFd && age(engine.houseFd.fetched_at) < 7 * DAY) return engine.feedOk('House Clerk disclosures', { interval_ms: 3600_000, records: engine.houseFd.filings.length });
    const years = [2026, 2025];
    const data = { ...(await clerk.fetchYears(years)), years };
    engine.houseFd = data;
    store.save('house-disclosures.json', data);
    engine.feedOk('House Clerk disclosures', { interval_ms: 3600_000, records: data.filings.length });
    engine.bump('disclosures');
  }, () => 3600_000);

  // Congress.gov member records and Senate eFD searches: on demand, one at a time.
  const cg = createCongressAdapter({ fetchImpl });
  loop('Congress.gov', async () => {
    const [id] = engine.congressRequests;
    if (!id) return engine.feeds['Congress.gov'] || engine.feedOk('Congress.gov', { interval_ms: 5_000, records: Object.keys(engine.congressMembers).length });
    engine.congressRequests.delete(id);
    engine.congressMembers[id] = await cg.member(id);
    store.save('congress-members.json', engine.congressMembers);
    engine.feedOk('Congress.gov', { interval_ms: 5_000, records: Object.keys(engine.congressMembers).length });
    engine.bump('congress');
  }, () => 5_000);

  const efd = createSenateEfdAdapter({ fetchImpl });
  loop('Senate eFD', async () => {
    const [req] = engine.efdRequests;
    if (!req) return;
    engine.efdRequests.delete(req);
    const { key, last } = JSON.parse(req);
    const surname = last.split(/\s+/).filter((w) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(w)).pop();
    try {
      engine.senateFd[key] = await efd.search(surname);
      engine.feedOk('Senate eFD', { interval_ms: 10_000, records: Object.keys(engine.senateFd).length });
    } catch (err) {
      engine.senateFd[key] = { ...(engine.senateFd[key] || {}), error: err.message, fetched_at: engine.senateFd[key]?.fetched_at || new Date().toISOString() };
      throw err;
    } finally {
      store.save('senate-efd.json', engine.senateFd);
      engine.bump('efd');
    }
  }, () => 10_000);

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

  return { stop: () => stops.forEach((s) => s()) };
}

const FINANCE_EVERY = 10 * 60_000; // checks every 10 min for Tier 1 races whose data is over a day old (or new to Tier 1)

export async function refreshFinance(engine, fec, { maxAgeMs = 24 * 3600_000, only = null } = {}) {
  // Order: races someone has opened (any tier), then Tier 1, then Tier 2 (only with a real key,
  // since DEMO_KEY allows so few requests). Tier 3 is fetched only when a race page is viewed.
  const due = (id) => !engine.finance[id] || Date.now() - Date.parse(engine.finance[id].fetched_at) > maxAgeMs || engine.finance[id].error;
  const fedOffice = (r) => r.office === 'S' || r.office === 'H';
  const all = engine.state().races.filter(fedOffice);
  const requested = [...engine.financeRequests].map((id) => all.find((r) => r.id === id)).filter(Boolean);
  const races = (only ? requested : [...requested, ...all.filter((r) => r.tier === 1), ...(hasRealKey() ? all.filter((r) => r.tier === 2) : [])])
    .filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i)
    .filter((r) => due(r.id) || engine.financeRequests.has(r.id) && !engine.finance[r.id]);
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
          ? rec.candidates.filter((c) => known.some((k) => surnameMatches(c.fec_name, k.name)))
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
    engine.financeRequests.delete(r.id);
    store.save('finance.json', engine.finance);
    engine.bump('finance');
    done++;
    if (lastErr && done === 1 && !rec.candidates.length) throw lastErr;
    lastErr = null; // feed is down; stop this pass
  }
  return done;
}
