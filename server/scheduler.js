// Polling loops. Each feed runs on its own timer and reports health to the engine.
import { createKalshiAdapter, kalshiHistory } from './adapters/kalshi.js';
import { createPolymarketAdapter, polymarketHistory } from './adapters/polymarket.js';
import { createApAdapter, createDdhqAdapter, createFileAdapter } from './adapters/results.js';
import { intervals } from './engine.js';
import { store } from './store.js';
import { mapLimit } from './lib/util.js';

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
