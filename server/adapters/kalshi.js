// Kalshi public market data. No key needed for read-only endpoints.
// Docs: https://docs.kalshi.com/  Base: https://api.elections.kalshi.com/trade-api/v2
import { fetchJson, nowIso, mapLimit, num } from '../lib/util.js';
import { matchMarket, partyFromLabel } from '../lib/match.js';

export const SOURCE = 'Kalshi';
const BASE = process.env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const ELECTION_CATEGORY_RE = /election|politic/i;
const SERIES_CATEGORIES = (process.env.KALSHI_CATEGORIES || 'Elections,Politics').split(',');
const ELECTORAL_SERIES_RE = /^(KX)?(SENATE|GOV|HOUSE|CONTROL)/;

export function createKalshiAdapter({ fetchImpl, marketMap = {}, maxPages = 40 } = {}) {
  let known = new Map(); // event_ticker -> {raceId, title, series_ticker}
  let unmatched = [];

  function consider(ev, found, misses) {
    if (ev.category && !ELECTION_CATEGORY_RE.test(ev.category)) return;
    const key = `kalshi:${ev.event_ticker}`;
    let rid;
    if (key in marketMap) rid = marketMap[key];
    else rid = matchMarket({ title: ev.title, subtitle: ev.sub_title, ticker: ev.event_ticker, seriesTicker: ev.series_ticker })?.raceId;
    if (rid) found.set(ev.event_ticker, { raceId: rid, title: ev.title, series_ticker: ev.series_ticker });
    else if (rid !== null && looksElectoral(ev.title)) misses.push({ key, title: ev.title, source: SOURCE });
  }

  // Preferred path: list election/politics series, then their open events.
  // Paging every open event instead would wade through thousands of sports markets.
  async function discoverBySeries(found, misses) {
    const series = new Map();
    for (const cat of SERIES_CATEGORIES) {
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const body = await fetchJson(`${BASE}/series?category=${encodeURIComponent(cat)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { fetchImpl });
        for (const s of body.series || []) if (ELECTORAL_SERIES_RE.test(s.ticker || '') || /senate|house|governor|gubernatorial|congress|ballot|proposition|amendment/i.test(s.title || '')) series.set(s.ticker, s);
        cursor = body.cursor;
        if (!cursor) break;
      }
    }
    if (!series.size) return 0;
    const lists = await mapLimit([...series.keys()], 2, (t) => fetchJson(`${BASE}/events?series_ticker=${encodeURIComponent(t)}&status=open&limit=200`, { fetchImpl }));
    let ok = 0;
    for (const body of lists) {
      if (body?.error) continue;
      ok++;
      for (const ev of body.events || []) consider(ev, found, misses);
    }
    return ok;
  }

  async function discoverByPaging(found, misses) {
    let cursor = '';
    for (let page = 0; page < maxPages; page++) {
      const url = `${BASE}/events?status=open&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await fetchJson(url, { fetchImpl });
      for (const ev of body.events || []) consider(ev, found, misses);
      cursor = body.cursor;
      if (!cursor) break;
    }
  }

  async function discover() {
    const found = new Map();
    const misses = [];
    let method = 'series';
    try {
      const n = await discoverBySeries(found, misses);
      if (!n) throw new Error('no election series listed');
    } catch {
      method = 'paging';
      await discoverByPaging(found, misses);
    }
    known = found;
    unmatched = misses;
    return { matched: found.size, unmatched: misses.length, method };
  }

  async function refresh() {
    // Discovery is driven by the scheduler; with nothing discovered there is nothing to refresh.
    if (known.size === 0) return { records: [], errors: [] };
    const entries = [...known.entries()];
    const results = await mapLimit(entries, 2, async ([ticker, meta]) => {
      const body = await fetchJson(`${BASE}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`, { fetchImpl });
      return normalizeEvent(body, meta);
    });
    const records = results.filter((r) => r && !r.error);
    const errors = results.filter((r) => r?.error).map((r) => r.error.message);
    if (records.length === 0 && errors.length) throw new Error(`All Kalshi event fetches failed: ${errors[0]}`);
    return { records, errors };
  }

  return { source: SOURCE, discover, refresh, getUnmatched: () => unmatched, getKnown: () => known };
}

function looksElectoral(title = '') {
  return /senate|governor|house|district|congress/i.test(title) && /2026|midterm/i.test(title);
}

// Price in [0,1]. Prefer bid/ask midpoint when the spread is tight, else last trade.
export function kalshiPrice(m) {
  const bid = dollars(m.yes_bid_dollars, m.yes_bid);
  const ask = dollars(m.yes_ask_dollars, m.yes_ask);
  const last = dollars(m.last_price_dollars, m.last_price);
  if (bid !== null && ask !== null && ask > 0 && ask - bid <= 0.1) return round((bid + ask) / 2);
  if (last !== null && last > 0) return round(last);
  if (bid !== null && ask !== null && ask > 0) return round((bid + ask) / 2);
  return null;
}

function dollars(dollarField, centsField) {
  const d = num(dollarField);
  if (d !== null) return d;
  const c = num(centsField);
  return c === null ? null : c / 100;
}
const round = (x) => Math.round(x * 1000) / 1000;

export function normalizeEvent(body, meta) {
  const ev = body.event || body;
  // With nested markets the list sits inside the event; the top-level array can be present but empty.
  const markets = (body.markets?.length ? body.markets : ev.markets) || [];
  const fetched_at = nowIso();
  const outcomes = markets
    .filter((m) => !m.status || ['active', 'open', 'initialized', 'closed', 'settled', 'finalized'].includes(m.status))
    .map((m) => {
      const label = m.yes_sub_title || m.subtitle || m.title || m.ticker;
      const suffix = (m.ticker || '').split('-').pop();
      return {
        label,
        party: partyFromLabel(label) || (suffix === 'D' || suffix === 'R' ? suffix : null),
        price: kalshiPrice(m),
        volume: num(m.volume_fp ?? m.volume),
        volume_24h: num(m.volume_24h_fp ?? m.volume_24h),
        market_id: m.ticker,
        status: m.status,
        result: m.result || null,
      };
    });
  const volume = outcomes.reduce((a, o) => a + (o.volume || 0), 0);
  return {
    raceId: meta.raceId,
    source: SOURCE,
    market_id: ev.event_ticker,
    series_ticker: ev.series_ticker || meta.series_ticker,
    title: ev.title || meta.title,
    source_url: `https://kalshi.com/markets/${(ev.series_ticker || meta.series_ticker || '').toLowerCase()}`,
    api_url: `${BASE}/events/${ev.event_ticker}`,
    fetched_at,
    volume,
    volume_unit: 'contracts',
    outcomes,
  };
}

// Hourly candles for history backfill.
export async function kalshiHistory({ seriesTicker, marketTicker, startTs, endTs, fetchImpl }) {
  const url = `${BASE}/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=60`;
  const body = await fetchJson(url, { fetchImpl });
  return (body.candlesticks || [])
    .map((c) => {
      const close = c.price?.close_dollars ?? (c.price?.close != null ? c.price.close / 100 : null);
      const mid = c.yes_bid?.close != null && c.yes_ask?.close != null ? (c.yes_bid.close + c.yes_ask.close) / 200 : null;
      const p = num(close) ?? mid;
      return p === null ? null : { t: new Date(c.end_period_ts * 1000).toISOString(), p: round(p) };
    })
    .filter(Boolean);
}
