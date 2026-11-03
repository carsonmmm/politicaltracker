// Central state: race catalog, merged results, odds, history, manual entries.
import path from 'node:path';
import { STATES, BY_POSTAL, SENATE_REGULAR, SENATE_SPECIAL, GOVERNOR, SENATE_SOURCE_URL, GOVERNOR_SOURCE_URL, HOUSE_SOURCE_URL } from './lib/states.js';
import { raceId, nameKey, lastName, partyFromLabel } from './lib/match.js';
import { ROOT, readJson, nowIso } from './lib/util.js';
import { store } from './store.js';
import { loadResearch, buildProfile, candidateKey, candidateSlug } from './profiles.js';
import { fecLastName } from './adapters/fec.js';

const cfg = (name) => readJson(path.join(ROOT, 'config', name), {});

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
    for (const k of ['results', 'candidates', 'notes', 'marketMap', 'profiles']) this.manual[k] ||= {};
    for (const k of ['ratings', 'polls', 'moments']) this.manual[k] ||= [];
    this.finance = store.load('finance.json', {}); // raceId -> {fetched_at, level, candidates, error}
    this.reloadResearch();
    this.calls = store.load('calls.json', []);
    this.callKeys = new Set(this.calls.map((c) => `${c.raceId}|${c.winner}|${c.calledBy}`));
    this.snapshot = store.load('odds-snapshot.json', {}); // raceId -> {source -> record}
    this.oddsHistory = new Map();
    this.resultsHistory = new Map();
    this.lastOddsPoint = new Map();
    const since = Date.now() - 1000 * 60 * 60 * 24 * 120;
    for (const row of store.readHistory('odds.jsonl', { sinceMs: since })) this.#pushOddsHist(row);
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
    this.feeds[name] = { ...(this.feeds[name] || {}), ...info, status: err.kind === 'auth' && /No .*KEY|not implemented/.test(err.message) ? 'unconfigured' : 'error', last_error: err.message, last_error_at: nowIso() };
  }

  // ----- odds -----
  ingestOdds(source, records) {
    const now = Date.now();
    const histRows = [];
    const touched = new Set();
    for (const rec of records) {
      if (!this.byId.has(rec.raceId) && !rec.raceId.startsWith('CONTROL-')) continue;
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
        const row = { t: rec.fetched_at, raceId: rec.raceId, source, market_id: o.market_id, label: o.label, party: o.party, p: o.price, vol: o.volume };
        histRows.push(row);
        this.#pushOddsHist(row);
      }
    }
    store.append('odds.jsonl', histRows);
    this.#saveSnapshot();
  }

  ingestOddsHistory(rows) {
    // Backfilled candles from before the app started.
    const existing = new Set();
    for (const r of rows) {
      const k = `${r.raceId}|${r.source}|${r.market_id}|${r.t}`;
      if (existing.has(k)) continue;
      existing.add(k);
      this.#pushOddsHist(r);
    }
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
    for (const p of this.research.profiles) if (p.raceId === rid) add({ name: p.name, party: p.party, incumbent: p.incumbent, source: 'Research file', source_url: p.source_url || p.bio?.source_url }, 'research file');
    for (const c of this.manual.candidates[rid] || []) add(c, 'Manual');
    return out;
  }

  oddsView(rid) {
    const bySource = this.odds.get(rid);
    const race = this.byId.get(rid);
    const ivl = intervals().odds;
    const sources = [];
    const candNames = race ? this.candidatesFor(rid, this.primaryResult(rid)) : [];
    for (const [src, rec] of bySource || []) {
      const age = Date.now() - Date.parse(rec.fetched_at);
      const parties = {};
      const outcomes = rec.outcomes.map((o) => {
        let party = o.party;
        if (!party && candNames.length) {
          const match = candNames.find((c) => lastName(c.name) && ` ${o.label.toLowerCase()} `.includes(` ${lastName(c.name)} `));
          if (match) party = match.party;
        }
        if (party && o.price !== null) parties[party] = Math.round(((parties[party] || 0) + o.price) * 1000) / 1000;
        return { ...o, party };
      });
      const low = (rec.volume ?? 0) < (LOW_VOLUME[rec.volume_unit] ?? 0);
      sources.push({ ...rec, outcomes, parties, stale: rec.from_snapshot || age > ivl * 1.5, age_ms: age, low_volume: low });
    }
    const avg = {};
    for (const p of ['D', 'R', 'O']) {
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
    const f = this.finance[rid];
    if (!f) return { available: false, reason: 'Not fetched yet. Finance is fetched daily for Tier 1 races from OpenFEC.' };
    if (f.error && !f.candidates?.length) return { available: false, reason: `OpenFEC request failed: ${f.error}`, fetched_at: f.fetched_at };
    const cands = this.candidatesFor(rid, this.primaryResult(rid));
    const used = new Set();
    const matched = cands.map((c) => {
      const prof = this.profileFor(rid, c);
      let row = prof.fec_id ? f.candidates.find((x) => x.fec_id === prof.fec_id) : null;
      if (!row) {
        const ln = lastName(c.name).replace(/[^a-z-]/g, '');
        const hits = f.candidates.filter((x) => fecLastName(x.fec_name) === ln && !used.has(x.fec_id));
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
      profile: this.profileFor(rid, c),
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
    };
  }

  balance(summaries) {
    const ch = this.chamberConfig();
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
      return { total: conf.total, majority: conf.majority, tiebreak: conf.tiebreak || null, not_up: conf.not_up, called, leading, uncalled, up: rs.length };
    };
    return {
      senate: mk('S', ch.senate),
      house: mk('H', ch.house),
      governors: mk('G', ch.governors),
      baseline: { verified: ch.verified, source: ch.source, source_url: ch.source_url, note: ch._note },
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
    return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 25);
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
      unmatchedCount: unmatched.length,
    };
  }
}

export { partyFromLabel };
