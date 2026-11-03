// VoteView (UCLA): roll-call votes and DW-NOMINATE ideology scores for every member of Congress.
// https://voteview.com/data  Static CSVs, no key.
import { nowIso, num } from '../lib/util.js';
import { parseDelimited } from './mit.js';

const BASE = process.env.VOTEVIEW_BASE || 'https://voteview.com/static/data/out';
export const CONGRESS = Number(process.env.VOTEVIEW_CONGRESS || 119); // 2025-2027
export const SOURCE = 'VoteView';
const PARTY = { 100: 'D', 200: 'R' };

async function getText(url, fetchImpl = fetch, timeoutMs = 180000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'midterm-live/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** Cast codes: 1-3 yea, 4-6 nay, 7 present, 8-9 not voting, 0 not a member. */
export function castLabel(code) {
  const c = Number(code);
  if (c >= 1 && c <= 3) return 'Yea';
  if (c >= 4 && c <= 6) return 'Nay';
  if (c === 7) return 'Present';
  if (c === 8 || c === 9) return 'Not voting';
  return null;
}

/**
 * Build the compact store: members since 1987 with ideology scores,
 * participation in the current Congress, and casts on configured key votes.
 */
export function buildVoteview({ members, votes = [], rollcalls = [], keyVotes = [] }) {
  const ms = members
    .filter((m) => Number(m.congress) >= 100 && m.chamber !== 'President')
    .map((m) => ({
      icpsr: m.icpsr, congress: Number(m.congress), chamber: m.chamber, state: m.state_abbrev, district: num(m.district_code),
      party: PARTY[m.party_code] || 'O', bioname: m.bioname, bioguide_id: m.bioguide_id || null,
      dim1: num(m.nominate_dim1), dim2: num(m.nominate_dim2),
    }));
  // Rank within each chamber of the current Congress, by first dimension.
  const ranks = {};
  for (const ch of ['Senate', 'House']) {
    const cur = ms.filter((m) => m.congress === CONGRESS && m.chamber === ch && m.dim1 !== null).sort((a, b) => a.dim1 - b.dim1);
    cur.forEach((m, i) => (ranks[`${ch}|${m.icpsr}`] = { rank: i + 1, of: cur.length }));
  }
  const participation = {};
  const keyRolls = new Set(keyVotes.map((k) => `${k.chamber}|${k.rollnumber}`));
  const keyCasts = {};
  for (const v of votes) {
    const label = castLabel(v.cast_code);
    if (!label) continue;
    const p = (participation[`${v.chamber}|${v.icpsr}`] ||= { cast: 0, missed: 0 });
    if (label === 'Not voting') p.missed++;
    else p.cast++;
    const k = `${v.chamber}|${v.rollnumber}`;
    if (keyRolls.has(k)) (keyCasts[k] ||= {})[v.icpsr] = label;
  }
  const rollInfo = {};
  for (const r of rollcalls) {
    const k = `${r.chamber}|${r.rollnumber}`;
    if (keyRolls.has(k)) rollInfo[k] = { date: r.date, result: r.vote_result || null, question: r.vote_question || null, bill: r.bill_number || null, desc: r.vote_desc || r.dtl_desc || null, yea: num(r.yea_count), nay: num(r.nay_count) };
  }
  return { members: ms, ranks, participation, keyCasts, rollInfo, congress: CONGRESS };
}

export function createVoteviewAdapter({ fetchImpl } = {}) {
  return {
    source: SOURCE,
    async fetchAll(keyVotes = []) {
      const membersCsv = await getText(`${BASE}/members/HSall_members.csv`, fetchImpl);
      const out = { members: parseDelimited(membersCsv), votes: [], rollcalls: [] };
      for (const ch of [['S', 'Senate'], ['H', 'House']]) {
        const [v, r] = await Promise.all([
          getText(`${BASE}/votes/${ch[0]}${CONGRESS}_votes.csv`, fetchImpl),
          getText(`${BASE}/rollcalls/${ch[0]}${CONGRESS}_rollcalls.csv`, fetchImpl),
        ]);
        for (const row of parseDelimited(v)) out.votes.push({ ...row, chamber: ch[1] });
        for (const row of parseDelimited(r)) out.rollcalls.push({ ...row, chamber: ch[1] });
      }
      return { ...buildVoteview({ ...out, keyVotes }), fetched_at: nowIso(), source_url: 'https://voteview.com/data' };
    },
  };
}

/** Congress.gov member record: offices held, from the official source. Needs an api.data.gov key (DEMO_KEY works slowly). */
export function createCongressAdapter({ fetchImpl } = {}) {
  const base = process.env.CONGRESS_BASE || 'https://api.congress.gov/v3';
  const key = () => process.env.CONGRESS_API_KEY || process.env.DATA_GOV_API_KEY || 'DEMO_KEY';
  return {
    source: 'Congress.gov',
    async member(bioguide) {
      const res = await (fetchImpl || fetch)(`${base}/member/${bioguide}?format=json&api_key=${key()}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Congress.gov HTTP ${res.status}`);
      const m = (await res.json()).member || {};
      const termsRaw = Array.isArray(m.terms) ? m.terms : m.terms?.item || [];
      const terms = termsRaw.map((t) => ({ chamber: t.chamber, congress: t.congress, start: t.startYear, end: t.endYear || null, state: t.stateCode || t.stateName, district: t.district ?? null }));
      return {
        bioguide_id: bioguide,
        name: m.directOrderName || m.invertedOrderName || null,
        terms,
        sponsored: m.sponsoredLegislation?.count ?? null,
        cosponsored: m.cosponsoredLegislation?.count ?? null,
        fetched_at: nowIso(),
        source_url: `https://www.congress.gov/member/${bioguide}`,
      };
    },
  };
}

/** Collapse consecutive terms in the same chamber and seat into offices held. */
export function officesFromTerms(terms = []) {
  const sorted = [...terms].sort((a, b) => (a.start || 0) - (b.start || 0));
  const out = [];
  for (const t of sorted) {
    const title = /senate/i.test(t.chamber) ? `U.S. Senator, ${t.state}` : `U.S. Representative, ${t.state}${t.district != null ? `-${t.district === 0 ? 'AL' : t.district}` : ''}`;
    const last = out.at(-1);
    if (last && last.title === title && (!last.to || !t.start || t.start - last.to <= 1)) last.to = t.end;
    else out.push({ title, from: t.start, to: t.end });
  }
  return out;
}
