// Polymarket Gamma API (market metadata + prices). No key needed.
// Docs: https://docs.polymarket.com/  Base: https://gamma-api.polymarket.com
import { fetchJson, nowIso, num } from '../lib/util.js';
import { matchMarket, partyFromLabel } from '../lib/match.js';

export const SOURCE = 'Polymarket';
const BASE = process.env.POLYMARKET_BASE || 'https://gamma-api.polymarket.com';
const CLOB = process.env.POLYMARKET_CLOB || 'https://clob.polymarket.com';
const DEFAULT_TAGS = (process.env.POLYMARKET_TAGS || 'midterms,senate,house,governor,us-elections,elections,politics').split(',');

export function createPolymarketAdapter({ fetchImpl, marketMap = {}, tags = DEFAULT_TAGS, maxPages = 10 } = {}) {
  let unmatched = [];

  async function fetchAll() {
    const seen = new Map();
    let anyOk = false;
    let lastErr;
    for (const tag of tags) {
      for (let page = 0; page < maxPages; page++) {
        const url = `${BASE}/events?closed=false&archived=false&limit=100&offset=${page * 100}&tag_slug=${encodeURIComponent(tag)}`;
        let body;
        try {
          body = await fetchJson(url, { fetchImpl });
          anyOk = true;
        } catch (err) {
          lastErr = err;
          break;
        }
        const list = Array.isArray(body) ? body : body.data || body.events || [];
        for (const ev of list) seen.set(ev.slug || ev.id, ev);
        if (list.length < 100) break;
      }
    }
    if (!anyOk && lastErr) throw lastErr;
    return [...seen.values()];
  }

  async function refresh() {
    const events = await fetchAll();
    const records = [];
    const misses = [];
    for (const ev of events) {
      const key = `polymarket:${ev.slug}`;
      let rid;
      if (key in marketMap) rid = marketMap[key];
      else rid = matchMarket({ title: ev.title, subtitle: '' })?.raceId;
      if (rid) records.push(normalizeEvent(ev, rid));
      else if (rid !== null && /senate|governor|house|district/i.test(ev.title || '')) misses.push({ key, title: ev.title, source: SOURCE });
    }
    unmatched = misses;
    return { records, errors: [] };
  }

  return { source: SOURCE, discover: async () => ({}), refresh, getUnmatched: () => unmatched };
}

function parseArr(v) {
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(v || '[]');
  } catch {
    return [];
  }
}

export function normalizeEvent(ev, raceId) {
  const fetched_at = nowIso();
  const markets = (ev.markets || []).filter((m) => !m.closed || m.umaResolutionStatus === 'resolved');
  const outcomes = [];
  for (const m of markets) {
    const names = parseArr(m.outcomes);
    const prices = parseArr(m.outcomePrices).map(Number);
    const tokens = parseArr(m.clobTokenIds);
    const vol = num(m.volumeNum ?? m.volume);
    if (names.length === 2 && /^yes$/i.test(names[0]) && markets.length > 1) {
      // Multi-outcome event: each market is "Will <X> win?" with Yes/No.
      const label = m.groupItemTitle || m.question;
      outcomes.push({ label, party: partyFromLabel(label), price: fin(prices[0]), volume: vol, market_id: m.id, token_id: tokens[0] || null });
    } else if (names.length === 2 && /^yes$/i.test(names[0])) {
      // Single binary market: "Will Democrats win X?"
      const label = m.question || ev.title;
      const party = partyFromLabel(label);
      outcomes.push({ label, party, price: fin(prices[0]), volume: vol, market_id: m.id, token_id: tokens[0] || null });
    } else {
      // Named outcomes, e.g. ["Democratic","Republican"].
      names.forEach((n, i) => outcomes.push({ label: n, party: partyFromLabel(n), price: fin(prices[i]), volume: vol, market_id: `${m.id}:${i}`, token_id: tokens[i] || null }));
    }
  }
  return {
    raceId,
    source: SOURCE,
    market_id: ev.slug,
    title: ev.title,
    source_url: `https://polymarket.com/event/${ev.slug}`,
    api_url: `${BASE}/events?slug=${ev.slug}`,
    fetched_at,
    volume: num(ev.volume) ?? outcomes.reduce((a, o) => a + (o.volume || 0), 0),
    volume_unit: 'USD',
    outcomes,
  };
}

const fin = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

export async function polymarketHistory({ tokenId, fetchImpl }) {
  const body = await fetchJson(`${CLOB}/prices-history?market=${tokenId}&interval=max&fidelity=60`, { fetchImpl });
  return (body.history || []).map((h) => ({ t: new Date(h.t * 1000).toISOString(), p: fin(Number(h.p)) })).filter((h) => h.p !== null);
}
