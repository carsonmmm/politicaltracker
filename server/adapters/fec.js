// OpenFEC adapter: federal campaign finance for Senate and House races.
// Docs: https://api.open.fec.gov/developers/  Free key: https://api.data.gov/signup/
// DEMO_KEY works but is heavily rate-limited, so without a key we fetch only
// race-level summaries; with FEC_API_KEY we fetch full donor and outside-spending detail.
import { fetchJson, nowIso, num } from '../lib/util.js';

const BASE = process.env.FEC_BASE || 'https://api.open.fec.gov/v1';
export const SOURCE = 'FEC (OpenFEC)';
const CYCLE = 2026;

export function fecKey() {
  return process.env.FEC_API_KEY || 'DEMO_KEY';
}
export const hasRealKey = () => Boolean(process.env.FEC_API_KEY);

/** Simple token bucket so a whole refresh stays under the hourly limit. */
export function createLimiter(perHour) {
  const gap = 3_600_000 / perHour;
  let next = 0;
  return async function wait() {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}

export function createFecAdapter({ fetchImpl, perHour = Number(process.env.FEC_RATE_PER_HOUR || (hasRealKey() ? 900 : 25)) } = {}) {
  const wait = createLimiter(perHour);
  let calls = 0;
  const get = async (path, params = {}) => {
    await wait();
    calls++;
    const q = new URLSearchParams({ api_key: fecKey(), ...params });
    return fetchJson(`${BASE}${path}?${q}`, { fetchImpl, timeoutMs: 30000 });
  };

  /** Race-level list of every candidate who filed, sorted by money raised. */
  async function raceSummary(race) {
    const params = { cycle: CYCLE, office: race.office === 'S' ? 'senate' : 'house', state: race.state, election_full: 'true', sort: '-total_receipts', per_page: 20 };
    if (race.office === 'H') params.district = String(race.district).padStart(2, '0');
    const body = await get('/elections/', params);
    return (body.results || []).map((c) => ({
      fec_id: c.candidate_id,
      fec_name: c.candidate_name,
      name: displayName(c.candidate_name),
      party: fecParty(c.party_full || c.party),
      party_label: c.party_full || c.party || null,
      incumbent: /incumbent/i.test(c.incumbent_challenge_full || '') || c.incumbent_challenge === 'I',
      pcc_id: c.candidate_pcc_id || (c.committee_ids || [])[0] || null,
      receipts: num(c.total_receipts),
      disbursements: num(c.total_disbursements),
      cash_on_hand: num(c.cash_on_hand_end_period),
      coverage_end_date: c.coverage_end_date || null,
      source_url: `https://www.fec.gov/data/candidate/${c.candidate_id}/?cycle=${CYCLE}&election_full=true`,
    }));
  }

  /** Full detail for one candidate (4 calls). */
  async function candidateDetail(c, state) {
    const out = { ...c, detail: true };
    const totals = (await get(`/candidate/${c.fec_id}/totals/`, { cycle: CYCLE, election_full: 'true' })).results?.[0];
    if (totals) {
      out.receipts = num(totals.receipts) ?? out.receipts;
      out.disbursements = num(totals.disbursements) ?? out.disbursements;
      out.cash_on_hand = num(totals.last_cash_on_hand_end_period ?? totals.cash_on_hand_end_period) ?? out.cash_on_hand;
      out.coverage_end_date = totals.coverage_end_date || totals.last_report_end_date || out.coverage_end_date;
      out.small_individual = num(totals.individual_unitemized_contributions);
      out.large_individual = num(totals.individual_itemized_contributions);
      out.pac = num(totals.other_political_committee_contributions);
      out.party_committee = num(totals.political_party_committee_contributions);
      out.self_contributions = num(totals.candidate_contribution);
      out.self_loans = num(totals.loans_made_by_candidate ?? totals.loans_received_from_candidate);
    }
    const byState = await get('/schedules/schedule_a/by_state/by_candidate/', { candidate_id: c.fec_id, cycle: CYCLE, election_full: 'true', per_page: 100 });
    let inS = 0, outS = 0;
    for (const r of byState.results || []) {
      const t = num(r.total) || 0;
      if ((r.state || '').toUpperCase() === state) inS += t;
      else outS += t;
    }
    out.itemized_in_state = byState.results?.length ? inS : null;
    out.itemized_out_state = byState.results?.length ? outS : null;
    const ie = await get('/schedules/schedule_e/by_candidate/', { candidate_id: c.fec_id, cycle: CYCLE, election_full: 'true', per_page: 100, sort: '-total' });
    const spend = (ie.results || []).map((r) => ({ committee_id: r.committee_id, name: r.committee_name || r.committee?.name || r.committee_id, support: r.support_oppose_indicator === 'S', total: num(r.total) || 0 }));
    out.outside_for = spend.filter((s) => s.support).sort((a, b) => b.total - a.total);
    out.outside_against = spend.filter((s) => !s.support).sort((a, b) => b.total - a.total);
    out.outside_for_total = out.outside_for.reduce((a, s) => a + s.total, 0);
    out.outside_against_total = out.outside_against.reduce((a, s) => a + s.total, 0);
    if (c.pcc_id) {
      const reps = await get(`/committee/${c.pcc_id}/reports/`, { cycle: CYCLE, per_page: 40, sort: 'coverage_end_date' });
      out.history = reportHistory(reps.results || []);
    } else out.history = [];
    return out;
  }

  return { source: SOURCE, raceSummary, candidateDetail, calls: () => calls, perHour };
}

/** Cumulative receipts and cash on hand by report, ignoring superseded amendments. */
export function reportHistory(reports) {
  const byEnd = new Map();
  for (const r of reports) {
    if (!r.coverage_end_date) continue;
    const prev = byEnd.get(r.coverage_end_date);
    // Prefer the most recent filing for the same period.
    if (!prev || String(r.receipt_date || '') > String(prev.receipt_date || '')) byEnd.set(r.coverage_end_date, r);
  }
  const rows = [...byEnd.values()].sort((a, b) => a.coverage_end_date.localeCompare(b.coverage_end_date));
  let cum = 0;
  return rows.map((r) => {
    cum += num(r.total_receipts_period) || 0;
    return { t: new Date(r.coverage_end_date).toISOString(), receipts_cum: cum, cash: num(r.cash_on_hand_end_period), report: r.report_type_full || r.report_type || null };
  });
}

export function fecParty(p = '') {
  if (/democrat/i.test(p) || p === 'DEM') return 'D';
  if (/republican/i.test(p) || p === 'REP') return 'R';
  return 'O';
}

/** "OSSOFF, T. JONATHAN" -> "T. Jonathan Ossoff" */
export function displayName(fecName = '') {
  const [last, rest] = fecName.split(',').map((s) => s.trim());
  const title = (s) => (s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Mr|Mrs|Ms|Dr|Jr|Sr)\b\.?/gi, (m) => m.replace('.', '')).trim();
  return rest ? `${title(rest)} ${title(last)}`.replace(/\s+/g, ' ') : title(last);
}

export function fecLastName(fecName = '') {
  return (fecName.split(',')[0] || '').trim().toLowerCase().replace(/[^a-z-]/g, '');
}

/**
 * Does an FEC filer name ("O'ROURKE, ROBERT") belong to a display name ("Beto O'Rourke")?
 * Compares letters only and tries every trailing run of words, so compound
 * surnames ("Monica De La Cruz" vs "DE LA CRUZ, MONICA") match too.
 */
export function surnameMatches(fecName, name) {
  const fec = fecLastName(fecName).replace(/-/g, '');
  if (!fec) return false;
  const words = String(name).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/,?\s+\b(jr|sr|ii|iii|iv)\b\.?/g, ' ').split(/\s+/).filter(Boolean);
  for (let k = 1; k < words.length; k++) if (words.slice(k).join('').replace(/[^a-z]/g, '') === fec) return true;
  return words.length === 1 && words[0].replace(/[^a-z]/g, '') === fec;
}

export const fecMeta = (fetched_at = nowIso()) => ({ source: SOURCE, fetched_at });
