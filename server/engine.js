// Central state: race catalog, merged results, odds, history, manual entries.
import path from 'node:path';
import { STATES, BY_POSTAL, SENATE_REGULAR, SENATE_SPECIAL, GOVERNOR, SENATE_SOURCE_URL, GOVERNOR_SOURCE_URL, HOUSE_SOURCE_URL } from './lib/states.js';
import { raceId, nameKey, lastName, partyFromLabel } from './lib/match.js';
import { ROOT, readJson, nowIso } from './lib/util.js';
import { store } from './store.js';
import { loadResearch, buildProfile, candidateKey, candidateSlug } from './profiles.js';
import { surnameMatches } from './adapters/fec.js';
import { loadMeasures, measureSide, thresholdShare, measureId } from './measures.js';
import { officesFromTerms } from './adapters/voteview.js';

// Config files are re-read at most every 5 s (edits still show up quickly) instead of on every call.
const cfgCache = new Map();
const cfg = (name) => {
  const hit = cfgCache.get(name);
  if (hit && Date.now() - hit.at < 5000) return hit.data;
  const data = readJson(path.join(ROOT, 'config', name), {});
  cfgCache.set(name, { at: Date.now(), data });
  return data;
};

export const RESULT_PRIORITY = ['Manual', 'AP', 'Decision Desk HQ', 'State election office', 'Results file'];
export const LOW_VOLUME = { USD: Number(process.env.LOW_VOLUME_USD || 50000), contracts: Number(process.env.LOW_VOLUME_CONTRACTS || 50000) };
const ELECTION_NIGHT_START = Date.parse('2026-11-03T11:00:00Z');
const ELECTION_NIGHT_END = Date.parse('2026-11-05T12:00:00Z');

export function isElectionNight(t = Date.now()) {
  return t >= ELECTION_NIGHT_START && t <= ELECTION_NIGHT_END;
}
export function intervals(t = Date.now()) {
  const night = isElectionNight(t);
  return { odds: night ? 60_000 : 15 * 60_000, results: night ? 45_000 : 10 * 60_000, discover: 15 * 60_000 };
}

const RATING_SCORE = { 'Solid D': -3, 'Safe D': -3, 'Likely D': -2, 'Lean D': -1, 'Tilt D': -0.5, 'Toss-up': 0, 'Tossup': 0, 'Tilt R': 0.5, 'Lean R': 1, 'Likely R': 2, 'Solid R': 3, 'Safe R': 3 };
export const RATINGS = Object.keys(RATING_SCORE);

export function buildCatalog() {
  const formats = cfg('race-formats.json').states || {};
  const fmt = (office, state) => {
    const f = formats[state];
    if (!f || (f.offices && !f.offices.includes(office))) return {};
    const { offices, ...rest } = f;
    return rest;
  };
  const races = [];
  for (const st of [...SENATE_REGULAR, ...SENATE_SPECIAL].sort()) {
    races.push({ id: raceId('S', st), office: 'S', state: st, stateName: BY_POSTAL[st].name, special: SENATE_SPECIAL.includes(st), district: null, format: fmt('S', st), catalog_source_url: SENATE_SOURCE_URL });
  }
  for (const st of GOVERNOR) {
    races.push({ id: raceId('G', st), office: 'G', state: st, stateName: BY_POSTAL[st].name, special: false, district: null, format: fmt('G', st), catalog_source_url: GOVERNOR_SOURCE_URL });
  }
  for (const s of STATES) {
    const n = s.house;
    for (let d = n === 1 ? 0 : 1; d <= (n === 1 ? 0 : n); d++) {
      races.push({ id: raceId('H', s.postal, d), office: 'H', state: s.postal, stateName: s.name, special: false, district: d, format: fmt('H', s.postal), catalog_source_url: HOUSE_SOURCE_URL });
    }
  }
  return races;
}

export function officeLabel(r) {
  if (r.office === 'BM') return `${r.stateName} ${r.measure?.number || r.id}`;
  if (r.office === 'S') return `${r.stateName} Senate${r.special ? ' (special)' : ''}`;
  if (r.office === 'G') return `${r.stateName} Governor`;
  return `${r.state}-${r.district === 0 ? 'AL' : String(r.district).padStart(2, '0')}`;
}

export class Engine {
  constructor() {
    this.races = buildCatalog();
    this.byId = new Map(this.races.map((r) => [r.id, r]));
    this.odds = new Map(); // raceId -> Map(source -> record)
    this.results = new Map(); // raceId -> Map(source -> record)
    this.feeds = {}; // name -> health
    this.unmatched = {};
    this.version = 0;
    this.listeners = new Set();
    this.manual = store.load('manual.json', { results: {}, candidates: {}, ratings: [], polls: [], notes: {}, chamber: null, pollClosing: null, marketMap: {} });
    for (const k of ['results', 'candidates', 'notes', 'marketMap', 'profiles', 'measures', 'runoffs', 'recount', 'certification']) this.manual[k] ||= {};
    for (const k of ['ratings', 'polls', 'moments', 'lean', 'keyVotes']) this.manual[k] ||= [];
    // Phase 4 stores (fetched by the scheduler, cached on disk).
    this.past = store.load('past.json', null);
    this.voteview = store.load('voteview.json', null);
    this.houseFd = store.load('house-disclosures.json', null);
    this.congressMembers = store.load('congress-members.json', {});
    this.senateFd = store.load('senate-efd.json', {});
    this.congressRequests = new Set();
    this.efdRequests = new Set();
    this.voteviewStale = false;
    this.finance = store.load('finance.json', {}); // raceId -> {fetched_at, level, candidates, error}
    this.financeRequests = new Set(); // races viewed without finance data yet
    this.reloadResearch();
    this.calls = store.load('calls.json', []);
    this.callKeys = new Set(this.calls.map((c) => `${c.raceId}|${c.winner}|${c.calledBy}`));
    this.snapshot = store.load('odds-snapshot.json', {}); // raceId -> {source -> record}
    this.oddsHistory = new Map();
    this.resultsHistory = new Map();
    this.lastOddsPoint = new Map();
    const since = Date.now() - 1000 * 60 * 60 * 24 * 120;
    for (const row of store.readHistory('odds.jsonl', { sinceMs: since })) this.#pushOddsHist(row);
    for (const arr of this.oddsHistory.values()) sortByTime(arr); // backfilled rows sit after live rows in the file
    for (const row of store.readHistory('results.jsonl', { sinceMs: since })) this.#pushResultsHist(row);
    // Restore last snapshot so the app has *labelled stale* odds before the first fetch.
    for (const [rid, bySource] of Object.entries(this.snapshot)) {
      const m = new Map();
      for (const [src, rec] of Object.entries(bySource)) m.set(src, { ...rec, from_snapshot: true });
      this.odds.set(rid, m);
    }
    // Same for live results feeds (AP etc.): last-known counts survive a restart, labelled stale.
    this.resultsSnapshot = store.load('results-snapshot.json', {});
    for (const [rid, bySource] of Object.entries(this.resultsSnapshot)) {
      const m = new Map();
      for (const [src, rec] of Object.entries(bySource)) m.set(src, { ...rec, from_snapshot: true });
      this.results.set(rid, m);
    }
  }

  // ----- events -----
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  bump(reason) {
    this.version++;
    for (const fn of this.listeners) fn({ version: this.version, reason });
  }

  // ----- feed health -----
  feedOk(name, info = {}) {
    this.feeds[name] = { ...(this.feeds[name] || {}), ...info, status: 'ok', last_ok: nowIso(), last_error: null };
  }
  feedError(name, err, info = {}) {
    this.feeds[name] = { ...(this.feeds[name] || {}), ...info, status: err.kind === 'auth' && /No .*KEY|not implemented|No state result sites/.test(err.message) ? 'unconfigured' : 'error', last_error: err.message, last_error_at: nowIso() };
  }

  // ----- odds -----
  ingestOdds(source, records) {
    const now = Date.now();
    const histRows = [];
    const touched = new Set();
    for (const rec of records) {
      if (!this.byId.has(rec.raceId) && !rec.raceId.startsWith('CONTROL-')) {
        // A market for a ballot measure that is not in the catalog yet: surface it for Admin.
        if (rec.raceId.startsWith('BM-')) (this.unmatchedMeasures ||= new Map()).set(`${source}:${rec.market_id}`, { key: `${source.toLowerCase()}:${rec.market_id}`, title: `${rec.title} (measure ${rec.raceId} is not in the catalog; add it in Admin)`, source });
        continue;
      }
      if (!this.odds.has(rec.raceId)) this.odds.set(rec.raceId, new Map());
      const bySource = this.odds.get(rec.raceId);
      // A race may have several markets on one source; keep the highest-volume one as primary.
      const key = touched.has(`${rec.raceId}|${source}`) ? null : source;
      const existing = bySource.get(source);
      if (key === null && existing && (existing.volume || 0) >= (rec.volume || 0)) continue;
      bySource.set(source, rec);
      touched.add(`${rec.raceId}|${source}`);
      for (const o of rec.outcomes) {
        if (o.price === null) continue;
        const hk = `${rec.raceId}|${source}|${o.market_id}`;
        const last = this.lastOddsPoint.get(hk);
        if (last && Math.abs(last.p - o.price) < 0.005 && now - Date.parse(last.t) < 5 * 60_000) continue;
        const row = { t: rec.fetched_at, raceId: rec.raceId, source, market_id: o.market_id, label: o.label, party: rec.raceId.startsWith('BM-') ? measureSide(o.label) : o.party, p: o.price, vol: o.volume };
        histRows.push(row);
        this.#pushOddsHist(row);
      }
    }
    store.append('odds.jsonl', histRows);
    this.#saveSnapshot();
  }

  ingestOddsHistory(rows) {
    // Backfilled candles from before the app started. They are older than the
    // live points already held, so re-sort each touched race to keep time order.
    const touched = new Set();
    for (const r of rows) {
      this.#pushOddsHist(r);
      touched.add(r.raceId);
    }
    for (const rid of touched) sortByTime(this.oddsHistory.get(rid));
    store.append('odds.jsonl', rows);
  }

  #pushOddsHist(row) {
    if (!this.oddsHistory.has(row.raceId)) this.oddsHistory.set(row.raceId, []);
    const arr = this.oddsHistory.get(row.raceId);
    arr.push(row);
    if (arr.length > 20000) arr.splice(0, arr.length - 20000);
    const hk = `${row.raceId}|${row.source}|${row.market_id}`;
    const last = this.lastOddsPoint.get(hk);
    if (!last || Date.parse(row.t) >= Date.parse(last.t)) this.lastOddsPoint.set(hk, row);
  }

  #saveSnapshot() {
    const snap = {};
    for (const [rid, m] of this.odds) {
      snap[rid] = {};
      for (const [src, rec] of m) if (!rec.from_snapshot) snap[rid][src] = rec;
      if (!Object.keys(snap[rid]).length) snap[rid] = this.snapshot[rid] || {};
    }
    this.snapshot = snap;
    store.save('odds-snapshot.json', snap);
  }

  // ----- results -----
  ingestResults(source, records) {
    const histRows = [];
    const bySourceSeen = new Set();
    for (const rec of records) {
      if (!this.byId.has(rec.raceId)) continue;
      if (!this.results.has(rec.raceId)) this.results.set(rec.raceId, new Map());
      this.results.get(rec.raceId).set(source, rec);
      bySourceSeen.add(rec.raceId);
      const total = (rec.candidates || []).reduce((a, c) => a + (c.votes || 0), 0);
      const prev = this.resultsHistory.get(rec.raceId)?.at(-1);
      if (total > 0 && (!prev || prev.total !== total || prev.source !== source)) {
        const row = { t: rec.fetched_at, raceId: rec.raceId, source, total, pctExpected: rec.pctExpected ?? null, votes: Object.fromEntries((rec.candidates || []).map((c) => [c.name, c.votes])) };
        histRows.push(row);
        this.#pushResultsHist(row);
      }
      if (rec.call?.winner && rec.call?.calledBy) this.#recordCall(rec.raceId, rec.call, source);
    }
    // Drop records from this source that disappeared (e.g. removed from the file).
    for (const [rid, m] of this.results) if (m.has(source) && !bySourceSeen.has(rid)) m.delete(source);
    store.append('results.jsonl', histRows);
    this.#reconcileCalls();
    if (source !== 'Manual' && source !== 'Results file' && records.length) {
      for (const rec of records) (this.resultsSnapshot[rec.raceId] ||= {})[source] = rec;
      store.save('results-snapshot.json', this.resultsSnapshot);
    }
  }

  #pushResultsHist(row) {
    if (!this.resultsHistory.has(row.raceId)) this.resultsHistory.set(row.raceId, []);
    this.resultsHistory.get(row.raceId).push(row);
  }

  #recordCall(rid, call, source) {
    const key = `${rid}|${call.winner}|${call.calledBy}`;
    if (this.callKeys.has(key)) return;
    this.callKeys.add(key);
    this.calls.unshift({ raceId: rid, winner: call.winner, party: call.party || null, calledBy: call.calledBy, calledAt: call.calledAt || nowIso(), seen_at: nowIso(), via: source, source_url: call.source_url || null });
    store.save('calls.json', this.calls);
  }

  /** Mark feed entries whose call no longer stands (corrected manual entry, outlet withdrew it). */
  #reconcileCalls() {
    let changed = false;
    for (const c of this.calls) {
      const cur = this.primaryResult(c.raceId)?.call;
      const stands = Boolean(cur?.winner && nameKey(cur.winner) === nameKey(c.winner));
      if (!stands && !c.retracted) { c.retracted = true; c.retracted_at = nowIso(); changed = true; }
      else if (stands && c.retracted) { delete c.retracted; delete c.retracted_at; changed = true; }
    }
    if (changed) store.save('calls.json', this.calls);
  }

  // ----- manual -----
  saveManual() {
    store.save('manual.json', this.manual);
    // Manual results take part in the normal merge as the "Manual" source.
    const recs = Object.values(this.manual.results);
    this.ingestResults('Manual', recs);
    this.bump('manual');
  }

  chamberConfig() {
    return this.manual.chamber || cfg('chamber.json');
  }
  pollClosing() {
    const base = cfg('poll-closing.json');
    return this.manual.pollClosing ? { ...base, ...this.manual.pollClosing, states: { ...base.states, ...(this.manual.pollClosing.states || {}) } } : base;
  }
  ratingsFor(rid) {
    const fileRatings = (cfg('ratings.json').entries || []).filter((r) => r.raceId === rid).map((r) => ({ ...r, origin: 'config/ratings.json' }));
    const man = this.manual.ratings.filter((r) => r.raceId === rid).map((r) => ({ ...r, origin: 'manual' }));
    return [...fileRatings, ...man].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }
  marketMap() {
    return { ...(cfg('market-map.json').map || {}), ...this.manual.marketMap };
  }

  // ----- views -----
  candidatesFor(rid, primary) {
    const out = [];
    const seen = new Map();
    const add = (c, origin) => {
      const k = nameKey(c.name);
      if (!k) return;
      if (seen.has(k)) {
        Object.assign(seen.get(k), Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== null && v !== '')));
        return;
      }
      const row = { ...c, origin };
      seen.set(k, row);
      out.push(row);
    };
    for (const c of primary?.candidates || []) add({ name: c.name, party: c.party, incumbent: c.incumbent, source: primary.source, source_url: primary.source_url }, primary.source);
    for (const p of this.research.profiles) if (p.raceId === rid) add({ name: p.name, party: p.party, incumbent: p.incumbent, source: p.source || 'Research file', source_url: p.source_url || p.bio?.source_url, sources: p.sources, listing_only: p.listing_only }, 'research file');
    for (const c of this.manual.candidates[rid] || []) add(c, 'Manual');
    return out;
  }

  oddsView(rid) {
    const bySource = this.odds.get(rid);
    const race = this.byId.get(rid);
    const ivl = intervals().odds;
    const sources = [];
    const candNames = race ? this.candidatesFor(rid, this.primaryResult(rid)) : [];
    // Party labels for names, from sourced data: the race's candidate list, outcome labels that
    // carry a party on any market (e.g. Polymarket "Jane Doe (D)"), and FEC filings. Used for
    // markets that list people without parties (e.g. Kalshi "(Person)" markets).
    const nameParty = new Map();
    const learn = (name, party) => { const ln = lastName(name); if (ln && party && !nameParty.has(ln)) nameParty.set(ln, party); };
    for (const c of candNames) learn(c.name, c.party);
    for (const rec of bySource?.values() || []) for (const o of rec.outcomes) if (o.party && /\([DRI]\)|\b(democrat|republican|independent)/i.test(o.label) && !/^(democratic|republican|independent)\b/i.test(o.label.trim())) learn(o.label, o.party);
    for (const f of this.finance[rid]?.candidates || []) learn(f.name, f.party);
    for (const [src, rec] of bySource || []) {
      const age = Date.now() - Date.parse(rec.fetched_at);
      const parties = {};
      const outcomes = rec.outcomes.map((o) => {
        let party = race?.office === 'BM' ? measureSide(o.label) : o.party;
        if (!party && race?.office !== 'BM') {
          const match = candNames.find((c) => lastName(c.name) && ` ${o.label.toLowerCase()} `.includes(` ${lastName(c.name)} `));
          party = match?.party || nameParty.get(lastName(o.label)) || null;
        }
        if (party && o.price !== null) parties[party] = Math.round(((parties[party] || 0) + o.price) * 1000) / 1000;
        return { ...o, party };
      });
      const low = (rec.volume ?? 0) < (LOW_VOLUME[rec.volume_unit] ?? 0);
      sources.push({ ...rec, outcomes, parties, stale: rec.from_snapshot || age > ivl * 1.5, age_ms: age, low_volume: low });
    }
    const avg = {};
    for (const p of race?.office === 'BM' ? ['Y', 'N'] : ['D', 'R', 'O']) {
      const vals = sources.filter((s) => s.parties[p] !== undefined).map((s) => s.parties[p]);
      if (vals.length) avg[p] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
    }
    return { sources, avg, n: sources.length };
  }

  primaryResult(rid) {
    const m = this.results.get(rid);
    if (!m || !m.size) return null;
    for (const src of RESULT_PRIORITY) if (m.has(src)) return m.get(src);
    return [...m.values()][0];
  }

  resultsView(rid) {
    const m = this.results.get(rid);
    const primary = this.primaryResult(rid);
    if (!primary) return { primary: null, alternates: [], disagreement: null };
    const race = this.byId.get(rid);
    const total = primary.candidates.reduce((a, c) => a + (c.votes || 0), 0);
    const cands = [...primary.candidates].sort((a, b) => (b.votes || 0) - (a.votes || 0)).map((c) => ({ ...c, pct: total ? Math.round((c.votes / total) * 10000) / 100 : null }));
    const leader = total > 0 ? cands[0] : null;
    const second = cands[1];
    const marginPct = leader && second ? Math.round((leader.pct - second.pct) * 100) / 100 : null;
    const age = Date.now() - Date.parse(primary.fetched_at);
    const stale = primary.from_snapshot || (age > intervals().results * 1.5 && !primary.manual && !primary.file);
    const alternates = [...(m?.values() || [])].filter((r) => r !== primary);
    let disagreement = null;
    for (const alt of alternates) {
      if (alt.call?.winner && primary.call?.winner && nameKey(alt.call.winner) !== nameKey(primary.call.winner)) disagreement = `${primary.source} and ${alt.source} show different winners.`;
      else if (alt.call?.winner && !primary.call?.winner) disagreement = `${alt.source} reports a call by ${alt.call.calledBy}; ${primary.source} does not.`;
      else {
        const altTotal = alt.candidates.reduce((a, c) => a + (c.votes || 0), 0);
        if (altTotal && total && Math.abs(altTotal - total) / Math.max(altTotal, total) > 0.02) disagreement ||= `${primary.source} and ${alt.source} vote totals differ by more than 2%.`;
      }
    }
    const fmt = race?.format || {};
    let majorityNote = null;
    if (fmt.majorityRequired && leader && leader.pct !== null && leader.pct <= 50 && total > 0) majorityNote = 'Leader is at or below 50%; this state requires a majority to avoid a runoff.';
    return { primary: { ...primary, candidates: cands, total, leader, marginPct, stale, age_ms: age }, alternates, disagreement, majorityNote };
  }

  tierFor(rid, oddsV, resV) {
    const ratings = this.ratingsFor(rid);
    const latestByOutlet = new Map();
    for (const r of ratings) if (!latestByOutlet.has(r.outlet)) latestByOutlet.set(r.outlet, r);
    const latest = [...latestByOutlet.values()];
    const reasons = [];
    let tier = 3;
    if (latest.some((r) => /toss|lean|tilt/i.test(r.rating))) {
      tier = 1;
      reasons.push('Rated Toss-up/Lean/Tilt by at least one forecaster');
    }
    const ps = Object.values(oddsV.avg);
    if (ps.some((p) => p >= 0.15 && p <= 0.85)) {
      tier = 1;
      reasons.push('Market-implied chance between 15% and 85%');
    }
    if (tier > 2 && latest.some((r) => /likely/i.test(r.rating))) {
      tier = 2;
      reasons.push('Rated Likely by a forecaster');
    }
    const p = resV.primary;
    if (tier > 1 && p && p.total > 0 && !p.call && p.marginPct !== null && p.marginPct < 5 && (p.pctExpected ?? 0) >= 25) {
      tier = 1;
      reasons.push(`Elevated tonight: margin ${p.marginPct} pts with ${p.pctExpected}% of expected vote counted`);
    }
    if (!reasons.length) reasons.push(latest.length ? 'Rated Solid/Safe' : 'No rating entered and no competitive market found');
    return { tier, reasons, ratings: latest };
  }

  raceSummary(r) {
    const oddsV = this.oddsView(r.id);
    const resV = this.resultsView(r.id);
    const tier = this.tierFor(r.id, oddsV, resV);
    const p = resV.primary;
    let status = p?.status || 'not_reporting';
    if (p?.call?.winner) status = 'called';
    return {
      id: r.id,
      office: r.office,
      state: r.state,
      stateName: r.stateName,
      district: r.district,
      special: r.special,
      label: officeLabel(r),
      tier: tier.tier,
      tierReasons: tier.reasons,
      status,
      call: p?.call || null,
      leader: p?.leader ? { name: p.leader.name, party: p.leader.party, pct: p.leader.pct } : null,
      marginPct: p?.marginPct ?? null,
      pctExpected: p?.pctExpected ?? null,
      totalVotes: p?.total ?? null,
      // Votes still to count, implied by the source's own estimate of the share counted.
      remainingImplied: p?.total && p.pctExpected > 0 && p.pctExpected < 100 ? Math.round(p.total * (100 / p.pctExpected - 1)) : null,
      marginVotes: p?.candidates?.length > 1 && p.total ? (p.candidates[0].votes || 0) - (p.candidates[1].votes || 0) : null,
      resultKind: p?.kind || null,
      resultSource: p?.source || null,
      resultFetchedAt: p?.fetched_at || null,
      resultStale: p?.stale || false,
      odds: oddsV.avg,
      oddsSources: oddsV.sources.map((s) => ({ source: s.source, stale: s.stale, low_volume: s.low_volume, fetched_at: s.fetched_at })),
      rating: tier.ratings[0] || null,
      hasCandidates: this.candidatesFor(r.id, p).length > 0,
    };
  }

  reloadResearch() {
    this.research = loadResearch();
    this.syncMeasures();
  }

  /** Ballot measures join the race catalog from the research file and Admin entries. */
  syncMeasures() {
    const loaded = loadMeasures();
    this.measureErrors = loaded.errors;
    const all = new Map();
    for (const m of loaded.measures) all.set(measureId(m.state, m.number), m);
    for (const [id, m] of Object.entries(this.manual.measures || {})) all.set(id, { ...all.get(id), ...m, origin: all.has(id) ? 'research file + Manual' : 'Manual' });
    this.races = this.races.filter((r) => r.office !== 'BM');
    for (const [id, m] of all) {
      const st = BY_POSTAL[m.state];
      this.races.push({ id, office: 'BM', state: m.state, stateName: st.name, district: null, special: false, format: { threshold: m.threshold || 'majority' }, measure: m, catalog_source_url: m.summary_source_url || `https://ballotpedia.org/${encodeURIComponent(st.name.replace(/ /g, '_'))}_2026_ballot_measures` });
    }
    this.byId = new Map(this.races.map((r) => [r.id, r]));
    this.stateCache = null;
  }

  measureLookup(state, label, apId) {
    for (const r of this.races) if (r.office === 'BM' && r.state === state && r.measure.ap_race_id && String(r.measure.ap_race_id) === String(apId)) return r.id;
    const id = measureId(state, label || '');
    return id && this.byId.has(id) ? id : null;
  }

  profileFor(rid, cand) {
    const k = candidateKey(rid, cand.name);
    const research = this.research.profiles.find((p) => candidateKey(p.raceId, p.name) === k);
    const manual = this.manual.profiles[k];
    return buildProfile({ raceId: rid, slug: candidateSlug(cand.name), key: k, name: cand.name, party: cand.party, party_label: cand.party_label, incumbent: cand.incumbent }, research, manual);
  }

  /** Link the race's known candidates to FEC filers. FEC lists every filer, including primary losers. */
  financeFor(rid) {
    const race = this.byId.get(rid);
    if (!race) return null;
    if (race.office === 'G') return { available: false, reason: 'Governor candidates file with their state, not the FEC. State disclosure sites are not connected yet.' };
    if (race.office === 'BM') return { available: false, reason: 'Ballot measure committees file with the state; amounts raised are shown from the sourced measure entry.' };
    const f = this.finance[rid];
    if (!f) return { available: false, pending: this.financeRequests.has(rid), reason: this.financeRequests.has(rid) ? 'Requested from OpenFEC just now; it appears here within a minute if the FEC is reachable.' : 'Not fetched yet.' };
    if (f.error && !f.candidates?.length) return { available: false, reason: `OpenFEC request failed: ${f.error}`, fetched_at: f.fetched_at };
    const cands = this.candidatesFor(rid, this.primaryResult(rid));
    const used = new Set();
    const matched = cands.map((c) => {
      const prof = this.profileFor(rid, c);
      let row = prof.fec_id ? f.candidates.find((x) => x.fec_id === prof.fec_id) : null;
      if (!row) {
        const hits = f.candidates.filter((x) => surnameMatches(x.fec_name, c.name) && !used.has(x.fec_id));
        row = hits.find((x) => x.party === c.party) || (hits.length === 1 ? hits[0] : null);
      }
      if (row) used.add(row.fec_id);
      return { name: c.name, party: c.party, slug: candidateSlug(c.name), finance: row || null, match: row ? (prof.fec_id ? 'fec_id' : 'name') : null };
    });
    const others = f.candidates.filter((x) => !used.has(x.fec_id));
    const age = Date.now() - Date.parse(f.fetched_at);
    return { available: true, fetched_at: f.fetched_at, level: f.level, stale: age > 36 * 3600_000, source: 'FEC (OpenFEC)', source_url: f.source_url, matched, others, partial_error: f.error || null };
  }

  momentsFor(rid) {
    return [...this.research.moments.filter((m) => m.raceId === rid), ...this.manual.moments.filter((m) => m.raceId === rid).map((m) => ({ ...m, origin: 'Manual' }))].sort((a, b) => b.date.localeCompare(a.date));
  }

  candidateDetail(rid, slug) {
    const r = this.byId.get(rid);
    if (!r) return null;
    const cands = this.candidatesFor(rid, this.primaryResult(rid));
    const c = cands.find((x) => candidateSlug(x.name) === slug);
    if (!c) return null;
    const fin = this.financeFor(rid);
    const mine = fin?.available ? fin.matched.find((m) => m.slug === slug) : null;
    return {
      race: { id: r.id, label: officeLabel(r), office: r.office, state: r.state, stateName: r.stateName },
      candidate: c,
      profile: this.withCongressOffices(rid, c, this.profileFor(rid, c)),
      voting: this.votingRecordFor(rid, c),
      disclosures: this.disclosuresFor(rid, c),
      finance: fin?.available ? { ...fin, mine: mine?.finance || null, match: mine?.match || null } : fin,
      opponents: cands.filter((x) => x !== c).map((x) => ({ name: x.name, party: x.party, slug: candidateSlug(x.name) })),
    };
  }

  raceDetail(rid) {
    const r = this.byId.get(rid);
    if (!r) return null;
    const summary = this.raceSummary(r);
    const resV = this.resultsView(rid);
    return {
      ...summary,
      race: r,
      results: resV,
      odds: this.oddsView(rid),
      oddsHistory: this.oddsHistory.get(rid) || [],
      resultsHistory: this.resultsHistory.get(rid) || [],
      candidates: this.candidatesFor(rid, resV.primary),
      ratings: this.ratingsFor(rid),
      polls: this.manual.polls.filter((p) => p.raceId === rid),
      notes: this.manual.notes[rid] || null,
      pollClose: this.pollClosing().states?.[r.state] || null,
      finance: this.financeFor(rid),
      profiles: this.candidatesFor(rid, resV.primary).map((c) => this.profileFor(rid, c)),
      moments: this.momentsFor(rid),
      past: this.pastFor(rid),
      lean: this.manual.lean.filter((l) => l.raceId === rid),
      measure: r.office === 'BM' ? this.measureView(r) : null,
    };
  }

  // ---------- Phase 5: after election night ----------
  recountRules() {
    const base = cfg('recount-thresholds.json');
    return { ...base, states: { ...(base.states || {}), ...(this.manual.recount || {}) } };
  }
  certificationDates() {
    const base = cfg('certification.json');
    return { ...base, states: { ...(base.states || {}), ...(this.manual.certification || {}) } };
  }

  afterElection(summaries) {
    const recount = this.recountRules();
    const cert = this.certificationDates();
    const counted = summaries.filter((s) => s.totalVotes > 0);
    const uncalled = counted.filter((s) => s.status !== 'called' && s.status !== 'runoff')
      .map((s) => ({ id: s.id, label: s.label, office: s.office, status: s.status, leader: s.leader, marginPct: s.marginPct, marginVotes: s.marginVotes, pctExpected: s.pctExpected, totalVotes: s.totalVotes, remainingImplied: s.remainingImplied, resultSource: s.resultSource, resultFetchedAt: s.resultFetchedAt }))
      .sort((a, b) => (a.marginPct ?? 99) - (b.marginPct ?? 99));
    const watch = [];
    for (const s of counted) {
      if (s.office === 'BM' || s.marginPct === null) continue;
      const rule = recount.states?.[s.state];
      if (!rule) continue;
      const within = rule.margin_votes != null ? s.marginVotes <= rule.margin_votes : rule.margin_pct != null ? s.marginPct <= rule.margin_pct : false;
      const near = rule.margin_votes != null ? s.marginVotes <= rule.margin_votes * 2 : rule.margin_pct != null ? s.marginPct <= rule.margin_pct * 2 : false;
      if (within || near) watch.push({ id: s.id, label: s.label, state: s.state, marginPct: s.marginPct, marginVotes: s.marginVotes, status: s.status, within, rule, resultKind: s.resultKind });
    }
    const runoffs = [];
    for (const s of summaries) {
      const r = this.byId.get(s.id);
      const p = this.primaryResult(s.id);
      const advancing = (p?.candidates || []).filter((c) => c.advances);
      const date = this.manual.runoffs?.[s.id] || (r.format?.runoffDate ? { date: r.format.runoffDate, source_url: null, origin: 'config' } : null);
      const possible = r.format?.majorityRequired && s.status !== 'called' && s.leader && s.leader.pct !== null && s.leader.pct <= 50;
      if (s.status === 'runoff' || advancing.length || date || possible) {
        runoffs.push({ id: s.id, label: s.label, state: s.state, status: s.status, confirmed: s.status === 'runoff' || advancing.length > 0, candidates: advancing.length ? advancing.map((c) => ({ name: c.name, party: c.party })) : null, calledBy: advancing.length || s.status === 'runoff' ? s.resultSource : null, date, possible: Boolean(possible && !advancing.length && s.status !== 'runoff'), leaderPct: s.leader?.pct ?? null });
      }
    }
    return { uncalled, recount: { rules: recount, watch: watch.sort((a, b) => a.marginPct - b.marginPct) }, runoffs, certification: cert, expected: this.expectedVsActual(summaries) };
  }

  /** Pre-election odds/rating/poll favourite vs. the called winner, for every called race. */
  expectedVsActual(summaries) {
    const cutoff = ELECTION_NIGHT_START;
    const rows = [];
    for (const s of summaries) {
      if (s.status !== 'called' || !s.call || s.office === 'BM') continue;
      const hist = (this.oddsHistory.get(s.id) || []).filter((h) => Date.parse(h.t) <= cutoff && (h.party === 'D' || h.party === 'R'));
      const lastBy = new Map();
      for (const h of hist) lastBy.set(`${h.source}|${h.party}`, h);
      const pre = {};
      for (const p of ['D', 'R']) {
        const vals = [...lastBy.values()].filter((h) => h.party === p).map((h) => h.p);
        if (vals.length) pre[p] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
      }
      // Favourite = the side priced higher. With only one side priced, compare it to 50%. Ties have no favourite.
      let marketFav = null;
      if (pre.D !== undefined && pre.R !== undefined) marketFav = pre.D > pre.R ? 'D' : pre.R > pre.D ? 'R' : null;
      else if (pre.D !== undefined) marketFav = pre.D > 0.5 ? 'D' : pre.D < 0.5 ? 'R' : null;
      else if (pre.R !== undefined) marketFav = pre.R > 0.5 ? 'R' : pre.R < 0.5 ? 'D' : null;
      const rating = this.ratingsFor(s.id).find((r) => Date.parse(r.date) <= cutoff) || null;
      const ratingFav = rating ? (/\bD\b/.test(rating.rating) ? 'D' : /\bR\b/.test(rating.rating) ? 'R' : 'Toss-up') : null;
      const poll = this.manual.polls.filter((p) => p.raceId === s.id && Date.parse(p.date) <= cutoff).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
      const cands = this.candidatesFor(s.id, this.primaryResult(s.id));
      let pollFav = null;
      if (poll?.values?.length) {
        const top = [...poll.values].sort((a, b) => b.pct - a.pct)[0];
        pollFav = cands.find((c) => nameKey(c.name) === nameKey(top.name))?.party || null;
      }
      rows.push({ id: s.id, label: s.label, winnerParty: s.call.party, winner: s.call.winner, calledBy: s.call.calledBy, finalMarginPct: s.marginPct, resultKind: s.resultKind,
        market: { pre, fav: marketFav, hit: marketFav ? marketFav === s.call.party : null, asOf: new Date(cutoff).toISOString() },
        rating: rating ? { ...rating, fav: ratingFav, hit: ratingFav === 'Toss-up' ? null : ratingFav === s.call.party } : null,
        poll: poll ? { average: poll.average, date: poll.date, source_url: poll.source_url, fav: pollFav, hit: pollFav ? pollFav === s.call.party : null } : null });
    }
    const tally = (k) => ({ hits: rows.filter((r) => r[k] && r[k].hit === true).length, misses: rows.filter((r) => r[k] && r[k].hit === false).length });
    return { rows, summary: { market: tally('market'), rating: tally('rating'), poll: tally('poll') }, cutoff: new Date(cutoff).toISOString() };
  }

  // ---------- Phase 4: past results, voting records, disclosures, measures ----------
  pastFor(rid) {
    const r = this.byId.get(rid);
    if (!r) return null;
    if (r.office === 'G') return { available: false, reason: 'MIT Election Lab does not publish governor results in its datasets.' };
    if (r.office === 'BM') return { available: false, reason: 'not applicable to ballot measures' };
    if (!this.past) return { available: false, reason: 'MIT Election Lab data not loaded yet (downloaded once from Harvard Dataverse at startup).' };
    const elections = this.past.races[rid] || [];
    if (!elections.length) return { available: false, reason: 'no earlier general election for this seat in the MIT dataset' };
    const f = this.past.files?.[r.office === 'S' ? 'senate' : 'house'];
    return { available: true, elections, president: this.past.president?.[r.state] || [], source: `MIT Election Lab${f?.file ? ` (${f.file})` : ''}`, source_url: f?.url || 'https://electionlab.mit.edu/data', fetched_at: this.past.fetched_at };
  }

  keyVotes() {
    const fileVotes = (cfg('key-votes.json').entries || []).map((k) => ({ ...k, origin: 'config/key-votes.json' }));
    return [...fileVotes, ...this.manual.keyVotes.map((k) => ({ ...k, origin: 'Manual' }))];
  }

  /** Find the candidate in VoteView by bioguide ID, else by surname + state (+ first name if needed). */
  memberFor(rid, cand) {
    if (!this.voteview) return { member: null, reason: 'VoteView data not loaded yet' };
    const r = this.byId.get(rid);
    const prof = this.profileFor(rid, cand);
    let rows;
    if (prof.bioguide_id) rows = this.voteview.members.filter((m) => m.bioguide_id === prof.bioguide_id);
    else {
      rows = this.voteview.members.filter((m) => m.state === r.state && surnameMatches(m.bioname, cand.name));
      const people = new Set(rows.map((m) => m.icpsr));
      if (people.size > 1) {
        const first = nameKey(cand.name).split(' ')[0];
        rows = rows.filter((m) => {
          const given = (m.bioname.split(',')[1] || '').trim().toLowerCase().split(/\s+/);
          return given.some((g) => g && (g.startsWith(first) || first.startsWith(g.replace(/[^a-z]/g, ''))));
        });
        if (new Set(rows.map((m) => m.icpsr)).size !== 1) return { member: null, reason: 'More than one former member of Congress from this state shares this surname; set the Bioguide ID in Admin to link the right one.' };
      }
    }
    if (!rows.length) return { member: null, reason: 'No match in VoteView: the candidate has not served in Congress since 1987, or the name differs. Set the Bioguide ID in Admin if they have.' };
    rows = [...rows].sort((a, b) => b.congress - a.congress);
    return { member: rows[0], rows, match: prof.bioguide_id ? 'bioguide' : 'name' };
  }

  votingRecordFor(rid, cand) {
    const { member, rows, reason, match } = this.memberFor(rid, cand);
    if (!member) return { available: false, reason };
    const vv = this.voteview;
    const cur = member.congress === vv.congress;
    const part = vv.participation[`${member.chamber}|${member.icpsr}`] || null;
    const rank = cur ? vv.ranks[`${member.chamber}|${member.icpsr}`] || null : null;
    const keyVotes = this.keyVotes().filter((k) => k.congress === vv.congress).map((k) => {
      const key = `${k.chamber}|${k.rollnumber}`;
      const rowsInChamber = rows.some((m) => m.congress === vv.congress && m.chamber === k.chamber);
      return { ...k, ...vv.rollInfo[key], position: rowsInChamber ? vv.keyCasts[key]?.[member.icpsr] || 'Not recorded' : null };
    }).filter((k) => k.position);
    if (member.bioguide_id && !this.congressMembers[member.bioguide_id]) this.congressRequests.add(member.bioguide_id);
    const congresses = rows.map((m) => m.congress);
    return {
      available: true, match,
      member: { bioname: member.bioname, bioguide_id: member.bioguide_id, icpsr: member.icpsr, chamber: member.chamber, party: member.party, first_congress: Math.min(...congresses), last_congress: Math.max(...congresses) },
      ideology: { dim1: member.dim1, dim2: member.dim2, congress: member.congress, chamber: member.chamber, rank },
      participation: cur && part ? { ...part, rate: part.cast + part.missed ? part.missed / (part.cast + part.missed) : null, congress: vv.congress } : null,
      keyVotes,
      keyVotesConfigured: this.keyVotes().length,
      source: 'VoteView', source_url: `https://voteview.com/person/${member.icpsr}`, fetched_at: vv.fetched_at,
    };
  }

  withCongressOffices(rid, cand, profile) {
    if (profile.offices.length) return profile;
    const vr = this.memberFor(rid, cand);
    const rec = vr.member?.bioguide_id ? this.congressMembers[vr.member.bioguide_id] : null;
    if (!rec?.terms?.length) return profile;
    return { ...profile, offices: officesFromTerms(rec.terms).map((o) => ({ ...o, source_url: rec.source_url, auto: 'Congress.gov' })), offices_source: 'Congress.gov' };
  }

  disclosuresFor(rid, cand) {
    const r = this.byId.get(rid);
    const out = { house: null, senate: null };
    const first = nameKey(cand.name).split(' ')[0];
    const firstOk = (f) => {
      const g = (f || '').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/);
      return g.some((x) => x && (x.startsWith(first) || first.startsWith(x)));
    };
    if (this.houseFd) {
      const mine = this.houseFd.filings.filter((x) => x.state_district.slice(0, 2) === r.state && surnameMatches(`${x.last}, ${x.first}`, cand.name));
      const people = new Set(mine.map((x) => `${x.last}|${x.first}`.toLowerCase()));
      const list = people.size > 1 ? mine.filter((x) => firstOk(x.first)) : mine;
      out.house = { available: true, filings: list.sort((a, b) => Date.parse(b.filed) - Date.parse(a.filed)), ptr_count: list.filter((x) => x.type === 'P').length, source: 'U.S. House Clerk', source_url: this.houseFd.source_url, fetched_at: this.houseFd.fetched_at, years: this.houseFd.years };
    } else out.house = { available: false, reason: 'House Clerk disclosure index not loaded yet' };
    if (r.office === 'S') {
      const key = `${nameKey(cand.name).split(' ').pop()}|${r.state}`;
      const rec = this.senateFd[key];
      if (!rec || Date.now() - Date.parse(rec.fetched_at) > 24 * 3600_000) this.efdRequests.add(JSON.stringify({ key, last: cand.name }));
      if (rec?.error && !rec.reports) out.senate = { available: false, reason: `Senate eFD search failed: ${rec.error}` };
      else if (rec) {
        const reports = rec.reports.filter((x) => firstOk(x.first));
        out.senate = { available: true, reports, ptr_count: reports.filter((x) => x.ptr).length, source: 'U.S. Senate eFD', source_url: rec.source_url, fetched_at: rec.fetched_at, stale: Boolean(rec.error) };
      } else out.senate = { available: false, pending: true, reason: 'Searching the Senate eFD; check back in a minute.' };
    }
    return out;
  }

  measureView(r) {
    const m = r.measure;
    const res = this.resultsView(r.id).primary;
    const yes = res?.candidates.find((c) => /^yes\b/i.test(c.name));
    const need = thresholdShare(m.threshold);
    return {
      ...m,
      need,
      yesPct: yes?.pct ?? null,
      thresholdNote: yes && res.total && m.threshold && m.threshold !== 'majority' ? `Yes needs ${m.threshold} to pass; it has ${yes.pct.toFixed(1)}%.` : null,
    };
  }

  balance(summaries) {
    const ch = structuredClone(this.chamberConfig());
    // Independents are shown on their own unless the baseline says (with a source) whom they caucus with.
    const cw = ch.senate?.independents_caucus_with;
    if ((cw === 'D' || cw === 'R') && ch.senate.not_up?.I) {
      ch.senate.not_up[cw] += ch.senate.not_up.I;
      ch.senate.caucus_note = `${ch.senate.not_up.I} independent(s) counted with ${cw === 'D' ? 'Democrats' : 'Republicans'} (caucus, per ${ch.senate.independents_caucus_source || 'Admin entry'})`;
      ch.senate.not_up.I = 0;
    }
    const mk = (office, conf) => {
      const rs = summaries.filter((s) => s.office === office);
      const called = { D: 0, R: 0, O: 0 };
      const leading = { D: 0, R: 0, O: 0 };
      let uncalled = 0;
      for (const s of rs) {
        if (s.status === 'called' && s.call) called[s.call.party in called ? s.call.party : 'O']++;
        else if (s.leader) leading[s.leader.party in leading ? s.leader.party : 'O']++;
        else uncalled++;
      }
      return { total: conf.total, majority: conf.majority, tiebreak: conf.tiebreak || null, not_up: conf.not_up, caucus_note: conf.caucus_note || null, not_up_note: conf.not_up_note || null, called, leading, uncalled, up: rs.length };
    };
    return {
      senate: mk('S', ch.senate),
      house: mk('H', ch.house),
      governors: mk('G', ch.governors),
      baseline: { verified: ch.verified, senate_verified: Boolean(ch.senate_verified), source: ch.source, source_url: ch.source_url, note: ch._note },
    };
  }

  movers(windowMs = 60 * 60_000) {
    const now = Date.now();
    const out = [];
    for (const [rid, rows] of this.oddsHistory) {
      const groups = new Map();
      for (const r of rows) {
        if (!r.party || r.party === 'O') continue;
        const k = `${r.source}|${r.market_id}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      for (const [k, arr] of groups) {
        const last = arr.at(-1);
        if (now - Date.parse(last.t) > windowMs * 2) continue;
        const before = [...arr].reverse().find((x) => now - Date.parse(x.t) >= windowMs);
        if (!before) continue;
        const delta = Math.round((last.p - before.p) * 1000) / 1000;
        if (Math.abs(delta) >= 0.01) out.push({ raceId: rid, source: last.source, label: last.label, party: last.party, from: before.p, to: last.p, delta, from_t: before.t, to_t: last.t });
      }
    }
    // One row per race and source: the D and R sides of a market move together, so keep the larger move.
    const best = new Map();
    for (const m of out) {
      const k = `${m.raceId}|${m.source}`;
      if (!best.has(k) || Math.abs(m.delta) > Math.abs(best.get(k).delta)) best.set(k, m);
    }
    return [...best.values()].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 25);
  }

  marketsVsExperts(summaries) {
    // Flags, with the rule shown on screen: a rating favours one party
    // (Lean/Likely/Solid) while the market average gives that party under 50%,
    // or a Toss-up rating while the market gives one side 80%+.
    const out = [];
    for (const s of summaries) {
      if (!s.rating || !Object.keys(s.odds).length) continue;
      const score = RATING_SCORE[s.rating.rating];
      if (score === undefined) continue;
      const fav = score < 0 ? 'D' : score > 0 ? 'R' : null;
      if (fav && Math.abs(score) >= 1 && s.odds[fav] !== undefined && s.odds[fav] < 0.5) out.push({ raceId: s.id, label: s.label, rating: s.rating, odds: s.odds, rule: `Rated ${s.rating.rating} but markets give ${fav} under 50%` });
      if (!fav && Object.entries(s.odds).some(([p, v]) => p !== 'O' && v >= 0.8)) out.push({ raceId: s.id, label: s.label, rating: s.rating, odds: s.odds, rule: 'Rated Toss-up but markets give one side 80% or more' });
    }
    return out;
  }

  state() {
    if (this.stateCache && this.stateCache.version === this.version && Date.now() - this.stateCache.at < 2000) return this.stateCache.value;
    const value = this.#buildState();
    this.stateCache = { version: this.version, at: Date.now(), value };
    return value;
  }

  #buildState() {
    const summaries = this.races.map((r) => this.raceSummary(r));
    const control = {};
    for (const id of ['CONTROL-S', 'CONTROL-H']) control[id] = this.oddsView(id);
    const unmatched = Object.values(this.unmatched).flat();
    return {
      version: this.version,
      generated_at: nowIso(),
      electionNight: isElectionNight(),
      intervals: intervals(),
      feeds: this.feeds,
      races: summaries,
      balance: this.balance(summaries),
      calls: this.calls.slice(0, 100),
      pollClosing: this.pollClosing(),
      control,
      movers: this.movers(),
      marketsVsExperts: this.marketsVsExperts(summaries),
      after: this.afterElection(summaries),
      unmatchedCount: unmatched.length,
    };
  }
}

export { partyFromLabel };

function sortByTime(arr) {
  if (arr) arr.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}
