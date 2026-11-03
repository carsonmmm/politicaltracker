// State election office results (free fallback when there is no AP/DDHQ key).
// Every state publishes differently, so feeds are listed in config/state-feeds.json.
// Supported type: "clarity" (Clarity/Scytl ENR sites used by several states and counties):
//   <url>current_ver.txt  -> version
//   <url><version>/json/en/summary.json -> contests
// State sites do not call races, so these records never carry a call.
import path from 'node:path';
import { fetchJson, nowIso, num, ROOT, readJson } from '../lib/util.js';
import { raceId } from '../lib/match.js';
import { BY_POSTAL } from '../lib/states.js';
import { MEASURE_LABEL_RE, measureId } from '../measures.js';

export const SOURCE = 'State election office';

/** Map a contest name on a state site to one of our race IDs (or null). */
export function contestToRace(state, name = '') {
  const n = name.replace(/\s+/g, ' ').trim();
  if (/lieutenant|state senate|state house|state representative|legislat|assembly|delegates/i.test(n)) return null;
  if (/\b(u\.?\s?s\.?|united states)\s+senat/i.test(n) || /^senator in congress/i.test(n)) return raceId('S', state);
  if (/^governor\b|\bgovernor$|governor and lieutenant governor/i.test(n)) return raceId('G', state);
  const h = n.match(/\b(?:u\.?\s?s\.?|united states)\s+(?:house|representative|rep\.?|congress)[^0-9]*(\d{1,2})|representative in congress[^0-9]*(\d{1,2})|congressional district[^0-9]*(\d{1,2})|\b(\d{1,2})(?:st|nd|rd|th) congressional district/i);
  if (h) {
    const d = Number(h[1] || h[2] || h[3] || h[4]);
    const seats = BY_POSTAL[state]?.house;
    if (seats === 1) return raceId('H', state, 0);
    if (d >= 1 && d <= seats) return raceId('H', state, d);
  }
  if (BY_POSTAL[state]?.house === 1 && /representative in congress|u\.?\s?s\.? (house|representative)|at[- ]large/i.test(n)) return raceId('H', state, 0);
  const m = n.match(MEASURE_LABEL_RE);
  if (m) return measureId(state, m[0]);
  return null;
}

const partyCode = (p = '') => (/^(dem|d)$|democrat/i.test(p.trim()) ? 'D' : /^(rep|r|gop)$|republican/i.test(p.trim()) ? 'R' : 'O');

/** Read a Clarity summary.json in either the older compact form or the newer verbose form. */
export function parseClaritySummary(body, state) {
  const contests = Array.isArray(body) ? body : body.Contests || body.contests || [];
  const out = [];
  for (const c of contests) {
    const name = c.C || c.contestName || c.name || '';
    const rid = contestToRace(state, name);
    if (!rid) continue;
    let cands = [];
    if (Array.isArray(c.CH)) {
      cands = c.CH.map((nm, i) => {
        const party = (c.P || [])[i] || (String(nm).match(/\(([^)]+)\)\s*$/) || [])[1] || '';
        return { name: String(nm).replace(/\s*\([^)]*\)\s*$/, '').trim(), party: partyCode(party), votes: num((c.V || [])[i]) ?? 0 };
      });
    } else if (Array.isArray(c.choices)) {
      cands = c.choices.map((ch) => ({ name: ch.name || ch.choiceName, party: partyCode(ch.party || ch.partyName || ''), votes: num(ch.votes ?? ch.totalVotes) ?? 0 }));
    }
    cands = cands.filter((x) => x.name && !/^(write-?in|over votes|under votes)$/i.test(x.name));
    if (!cands.length) continue;
    const reported = num(c.PR ?? c.precinctsReported);
    const total = num(c.TP ?? c.precinctsTotal ?? c.totalPrecincts);
    out.push({ raceId: rid, name, candidates: cands, precincts: reported != null && total ? { reported, total } : null });
  }
  return out;
}

export function loadFeeds(file = process.env.STATE_FEEDS_FILE || path.join(ROOT, 'config', 'state-feeds.json')) {
  return (readJson(file, { feeds: [] }).feeds || []).filter((f) => f && f.state && f.url && f.type);
}

export function createStateSitesAdapter({ fetchImpl } = {}) {
  return {
    source: SOURCE,
    get configured() {
      return loadFeeds().length > 0;
    },
    needs: 'feeds listed in config/state-feeds.json',
    async refresh() {
      const feeds = loadFeeds();
      if (!feeds.length) throw Object.assign(new Error('No state result sites configured (config/state-feeds.json)'), { kind: 'auth' });
      const records = [];
      const errors = [];
      for (const f of feeds) {
        try {
          if (f.type !== 'clarity') throw new Error(`unsupported type "${f.type}"`);
          const base = f.url.endsWith('/') ? f.url : `${f.url}/`;
          const res = await (fetchImpl || fetch)(`${base}current_ver.txt`, { headers: { 'User-Agent': 'midterm-live/0.1' } });
          if (!res.ok) throw new Error(`HTTP ${res.status} for current_ver.txt`);
          const ver = (await res.text()).trim();
          const body = await fetchJson(`${base}${ver}/json/en/summary.json`, { fetchImpl });
          const fetched_at = nowIso();
          for (const c of parseClaritySummary(body, f.state)) {
            const total = c.candidates.reduce((a, x) => a + x.votes, 0);
            records.push({
              raceId: c.raceId, source: SOURCE, source_detail: f.name || `${f.state} results site`, source_url: f.source_url || base, fetched_at,
              kind: 'unofficial', status: total > 0 ? 'counting' : 'not_reporting', pctExpected: null, call: null, candidates: c.candidates,
              counties: [], rcvRounds: [],
              outstanding_note: c.precincts ? `${c.precincts.reported} of ${c.precincts.total} precincts reporting (per ${f.name || 'the state site'}). Precincts reporting is not the same as share of votes counted.` : null,
            });
          }
        } catch (err) {
          errors.push(`${f.state}: ${err.message}`);
        }
      }
      if (!records.length && errors.length) throw new Error(errors.join('; '));
      return { records, errors };
    },
  };
}
