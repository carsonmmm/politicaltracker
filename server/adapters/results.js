// Results feed adapters. All produce the same ResultRecord shape:
// { raceId, source, source_url, fetched_at, kind, status, pctExpected,
//   call: {winner, party, calledBy, calledAt, source_url} | null,
//   candidates: [{name, party, votes, incumbent}], counties: [{fips, name, pctExpected, candidates}],
//   rcvRounds: [{round, candidates:[{name, votes}]}], outstanding_note }
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson, nowIso, num, ROOT, readJson } from '../lib/util.js';
import { raceId as makeRaceId } from '../lib/match.js';
import { BY_POSTAL } from '../lib/states.js';

export const STATUSES = ['not_reporting', 'counting', 'too_early', 'too_close', 'called', 'recount', 'runoff'];

// ---------- AP Elections API (paid; needs AP_API_KEY) ----------
// Written against AP's documented v3 JSON schema. Untested in this build
// because no key was available.
export function createApAdapter({ apiKey = process.env.AP_API_KEY, electionDate = '2026-11-03', fetchImpl } = {}) {
  const base = process.env.AP_BASE || 'https://api.ap.org/v3';
  return {
    source: 'AP',
    configured: Boolean(apiKey),
    needs: 'AP_API_KEY (paid AP Elections API subscription)',
    async refresh() {
      if (!apiKey) throw Object.assign(new Error('No AP_API_KEY set'), { kind: 'auth' });
      const url = `${base}/elections/${electionDate}?apikey=${apiKey}&format=json&statepostal=*&officeID=S,G,H,I&level=FIPSCode&resultsType=l`;
      const body = await fetchJson(url, { fetchImpl, timeoutMs: 30000 });
      return { records: normalizeAp(body), errors: [] };
    },
  };
}

const AP_PARTY = { Dem: 'D', GOP: 'R', Rep: 'R', Ind: 'I', Lib: 'O', Grn: 'O' };

export function normalizeAp(body) {
  const fetched_at = nowIso();
  const out = [];
  for (const race of body.races || []) {
    const office = { S: 'S', G: 'G', H: 'H' }[race.officeID];
    if (!office) continue;
    const state = race.statePostal || race.reportingUnits?.[0]?.statePostal;
    if (!BY_POSTAL[state]) continue;
    let rid;
    if (office === 'H') rid = makeRaceId('H', state, BY_POSTAL[state].house === 1 ? 0 : Number(race.seatNum));
    else rid = makeRaceId(office, state);
    const units = race.reportingUnits || [];
    const top = units.find((u) => u.level === 'state' || u.level === 'district') || units[0];
    if (!top) continue;
    const cands = (top.candidates || []).map((c) => ({
      name: [c.first, c.last].filter(Boolean).join(' '),
      party: AP_PARTY[c.party] || 'O',
      party_label: c.party,
      votes: num(c.voteCount) ?? 0,
      incumbent: Boolean(c.incumbent),
      ap_winner: c.winner || null,
    }));
    const winner = cands.find((c) => c.ap_winner === 'X');
    const runoff = cands.some((c) => c.ap_winner === 'R');
    let status = 'not_reporting';
    const total = cands.reduce((a, c) => a + c.votes, 0);
    if (winner) status = 'called';
    else if (runoff) status = 'runoff';
    else if (/recount/i.test(race.raceCallStatus || '')) status = 'recount';
    else if (/too close/i.test(race.raceCallStatus || '')) status = 'too_close';
    else if (total > 0) status = /too early/i.test(race.raceCallStatus || '') ? 'too_early' : 'counting';
    out.push({
      raceId: rid,
      source: 'AP',
      source_url: 'https://www.ap.org/elections/',
      fetched_at,
      updated_at: top.lastUpdated || body.timestamp || null,
      kind: 'unofficial',
      status,
      pctExpected: num(top.eevp ?? race.eevp) ?? null,
      call: winner ? { winner: winner.name, party: winner.party, calledBy: 'AP', calledAt: race.lastUpdated || top.lastUpdated || fetched_at, source_url: 'https://www.ap.org/elections/' } : null,
      candidates: cands.map(({ ap_winner, ...c }) => c),
      counties: units
        .filter((u) => u.level === 'FIPSCode' || u.level === 'county' || u.fipsCode)
        .filter((u) => u !== top)
        .map((u) => ({
          fips: u.fipsCode,
          name: u.reportingunitName,
          pctExpected: num(u.eevp),
          candidates: (u.candidates || []).map((c) => ({ name: [c.first, c.last].filter(Boolean).join(' '), party: AP_PARTY[c.party] || 'O', votes: num(c.voteCount) ?? 0 })),
        })),
      rcvRounds: [],
      outstanding_note: null,
    });
  }
  return out;
}

// ---------- Decision Desk HQ (paid; needs DDHQ credentials) ----------
// Not implemented: DDHQ's schema is only available to subscribers. With a
// key, write normalizeDdhq() mapping to ResultRecord and nothing else changes.
export function createDdhqAdapter() {
  return {
    source: 'Decision Desk HQ',
    configured: false,
    needs: 'DDHQ_CLIENT_ID / DDHQ_CLIENT_SECRET and an adapter written against their subscriber docs',
    async refresh() {
      throw Object.assign(new Error('Decision Desk HQ adapter not implemented (subscriber-only schema)'), { kind: 'auth' });
    },
  };
}

// ---------- Research file (free fallback) ----------
export function createFileAdapter({ file = path.join(ROOT, 'data', 'results-research.json') } = {}) {
  return {
    source: 'Results file',
    configured: true,
    file,
    async refresh() {
      if (!fs.existsSync(file)) return { records: [], errors: ['results file missing'] };
      const body = readJson(file, null);
      if (!body) throw Object.assign(new Error('results file is not valid JSON'), { kind: 'parse' });
      const records = [];
      const errors = [];
      for (const [i, e] of (body.entries || []).entries()) {
        const problem = validateEntry(e);
        if (problem) {
          errors.push(`entry ${i} (${e.raceId || '?'}): ${problem}`);
          continue;
        }
        records.push({ kind: 'unofficial', counties: [], rcvRounds: [], call: null, ...e, source: e.source, file: true });
      }
      return { records, errors };
    },
  };
}

export function validateEntry(e) {
  if (!e || typeof e !== 'object') return 'not an object';
  if (!e.raceId) return 'missing raceId';
  if (!e.source || !e.source_url || !e.fetched_at) return 'missing source, source_url or fetched_at';
  if (e.status && !STATUSES.includes(e.status)) return `unknown status "${e.status}"`;
  if (e.status === 'called' && (!e.call || !e.call.calledBy)) return 'status "called" needs call.calledBy (a named outlet)';
  if (!Array.isArray(e.candidates)) return 'candidates must be an array';
  return null;
}
