// Source reachability test. Run `npm run probe` or open /#/sources in the app.
// For each source: can this machine reach it, does it need a key, and would a
// browser be blocked by CORS (the app fetches server-side, so CORS only
// matters if you strip out the server).
import { redact } from './lib/util.js';

const FEC_KEY = () => process.env.FEC_API_KEY || 'DEMO_KEY';
const DATA_GOV_KEY = () => process.env.CONGRESS_API_KEY || process.env.DATA_GOV_API_KEY || 'DEMO_KEY';

export const SOURCES = [
  { id: 'kalshi', name: 'Kalshi public API', use: 'Market odds', key: 'none', url: () => 'https://api.elections.kalshi.com/trade-api/v2/events?limit=1&status=open' },
  { id: 'polymarket', name: 'Polymarket Gamma API', use: 'Market odds', key: 'none', url: () => 'https://gamma-api.polymarket.com/events?limit=1&closed=false' },
  { id: 'polymarket-clob', name: 'Polymarket CLOB price history', use: 'Odds history backfill', key: 'none', url: () => 'https://clob.polymarket.com/time' },
  { id: 'ap', name: 'AP Elections API', use: 'Vote counts and race calls', key: 'AP_API_KEY (paid)', needsKey: () => !process.env.AP_API_KEY, url: () => `https://api.ap.org/v3/elections?apikey=${process.env.AP_API_KEY || ''}&format=json` },
  { id: 'ddhq', name: 'Decision Desk HQ API', use: 'Vote counts and race calls', key: 'DDHQ credentials (paid)', needsKey: () => true, url: () => 'https://resultsapi.decisiondeskhq.com/' },
  { id: 'fec', name: 'OpenFEC API', use: 'Campaign finance (Phase 3)', key: 'FEC_API_KEY (free; DEMO_KEY works at low rate limits)', url: () => `https://api.open.fec.gov/v1/candidates/?api_key=${FEC_KEY()}&election_year=2026&office=S&per_page=1` },
  { id: 'congress', name: 'Congress.gov API', use: 'Voting records (Phase 4)', key: 'CONGRESS_API_KEY (free api.data.gov key)', url: () => `https://api.congress.gov/v3/member?api_key=${DATA_GOV_KEY()}&limit=1&format=json` },
  { id: 'voteview', name: 'VoteView', use: 'Ideology scores (Phase 4)', key: 'none', url: () => 'https://voteview.com/static/data/out/members/H119_members.csv', head: true },
  { id: 'mit', name: 'MIT Election Data + Science Lab (Harvard Dataverse)', use: 'Past results (Phase 4)', key: 'none', url: () => 'https://dataverse.harvard.edu/api/info/version' },
  { id: 'clarity', name: 'Clarity/Scytl ENR (used by several state offices)', use: 'State results fallback', key: 'none', url: () => 'https://results.enr.clarityelections.com/' },
];

export async function probeAll({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  return Promise.all(SOURCES.map((s) => probeOne(s, { fetchImpl, timeoutMs })));
}

async function probeOne(s, { fetchImpl, timeoutMs }) {
  const base = { id: s.id, name: s.name, use: s.use, key: s.key, checked_at: new Date().toISOString() };
  if (s.needsKey?.()) return { ...base, result: 'needs_key', detail: `Not tested: requires ${s.key}.` };
  const url = s.url();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: s.head ? 'HEAD' : 'GET', signal: ctrl.signal, headers: { 'User-Agent': 'midterm-live/0.1', Origin: 'http://localhost' } });
    const cors = res.headers.get('access-control-allow-origin');
    const corsNote = cors ? `Browser CORS: allowed (${cors})` : 'Browser CORS: no allow-origin header, so a browser-only app would be blocked; the server fetches it instead.';
    if (res.status === 401 || res.status === 403) return { ...base, result: 'needs_key', status: res.status, detail: `HTTP ${res.status} at ${redact(url)}. ${corsNote}` };
    if (res.status >= 500 || res.status === 429) return { ...base, result: 'error', status: res.status, detail: `HTTP ${res.status}. ${corsNote}` };
    return { ...base, result: 'reachable', status: res.status, detail: `HTTP ${res.status}. ${corsNote}` };
  } catch (err) {
    const code = err.cause?.code || err.code || err.name;
    return { ...base, result: 'unreachable', detail: `${code}: ${err.cause?.message || err.message}. This machine cannot reach the host (offline, firewall or proxy policy).` };
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await probeAll();
  for (const r of rows) console.log(`${r.result.padEnd(12)} ${r.name.padEnd(48)} ${r.detail}`);
}
