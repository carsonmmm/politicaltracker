// Campaign-finance rendering, shared by race and candidate pages.
// Raw metrics only. No score or grade is computed anywhere in the app.
import { esc, compact, money, pct, chip, src, notAvailable } from './ui.js';
import { lineChart } from './chart.js';

const usd = (n) => (n === null || n === undefined ? '—' : `$${compact(n)}`);

export function burnRate(f) {
  return f?.receipts > 0 && f.disbursements !== null ? f.disbursements / f.receipts : null;
}

export function financeSource(fin) {
  return src({ source: fin.source, source_url: fin.source_url, fetched_at: fin.fetched_at, stale: fin.stale, extra: fin.level === 'summary' ? ' <span class="tag warn" title="Set FEC_API_KEY for donor and outside-spending detail">Summary only</span>' : '' });
}

/** Headline numbers for one candidate. */
export function headline(f) {
  if (!f) return notAvailable('no FEC filing matched to this candidate');
  const br = burnRate(f);
  return `<dl class="kv">
    <dt>Total raised</dt><dd class="num"><b>${money(f.receipts)}</b></dd>
    <dt>Total spent</dt><dd class="num">${money(f.disbursements)}</dd>
    <dt>Cash on hand</dt><dd class="num">${money(f.cash_on_hand)}</dd>
    <dt>Burn rate</dt><dd class="num">${br === null ? '—' : pct(br)} <span class="tiny muted">spent ÷ raised</span></dd>
    <dt>Covers through</dt><dd>${esc(f.coverage_end_date ? f.coverage_end_date.slice(0, 10) : '—')}</dd>
    <dt>FEC record</dt><dd><a href="${esc(f.source_url)}" target="_blank" rel="noopener">${esc(f.fec_id)}</a> <span class="tiny muted">${esc(f.fec_name)}</span></dd>
  </dl>`;
}

/** Donor breakdown, in/out of state, outside spending and history. Needs full detail. */
export function breakdown(f) {
  if (!f) return '';
  if (!f.detail) return '<p class="small muted">Donor breakdown, in-state share and outside spending need a free FEC_API_KEY (the shared DEMO_KEY only allows summaries).</p>';
  const self = (f.self_contributions || 0) + (f.self_loans || 0);
  const parts = [
    ['Small donors (under $200)', f.small_individual, 'var(--accent)'],
    ['Large individual donors', f.large_individual, 'var(--dem-soft)'],
    ['PACs and other committees', f.pac, 'var(--oth)'],
    ['Party committees', f.party_committee, 'var(--muted)'],
    ['Self-funding (contributions + loans)', self, 'var(--rep-soft)'],
  ];
  const tot = parts.reduce((a, [, v]) => a + (v || 0), 0);
  const bar = tot ? `<div class="oddsbar" style="height:14px" role="img" aria-label="Donor mix">${parts.map(([l, v, c]) => `<span style="width:${((v || 0) / tot) * 100}%;background:${c}" title="${esc(l)}"></span>`).join('')}</div>` : '';
  const itemized = (f.itemized_in_state || 0) + (f.itemized_out_state || 0);
  const outside = (list) => (list.length ? `<ol class="small" style="padding-left:18px;margin:4px 0">${list.slice(0, 5).map((s) => `<li>${esc(s.name)} — ${usd(s.total)}</li>`).join('')}</ol>` : '<p class="small muted">None reported.</p>');
  return `<h3 style="margin-top:10px">Where the money came from</h3>${bar}
    <table><tbody>${parts.map(([l, v, c]) => `<tr><td><i style="display:inline-block;width:10px;height:10px;background:${c};border-radius:2px"></i> ${esc(l)}</td><td class="r num">${money(v)}</td><td class="r num muted">${tot && v != null ? pct(v / tot) : '—'}</td></tr>`).join('')}</tbody></table>
    <p class="tiny muted">Shares are of these five categories combined; total raised also includes transfers and other receipts. "Small donors" are unitemized contributions, which the FEC does not require donors to be named for.</p>
    <h3 style="margin-top:10px">In-state vs. out-of-state</h3>
    ${itemized ? `<p class="small">In-state ${money(f.itemized_in_state)} (<b>${pct(f.itemized_in_state / itemized)}</b>) · Out-of-state ${money(f.itemized_out_state)} (<b>${pct(f.itemized_out_state / itemized)}</b>)</p><p class="tiny muted">Itemized individual contributions only (donors giving over $200), by donor address.</p>` : notAvailable('no itemized contributions by state reported')}
    <h3 style="margin-top:10px">Outside spending</h3>
    <div class="row2"><div><b>Supporting: ${usd(f.outside_for_total)}</b>${outside(f.outside_for || [])}</div><div><b>Opposing: ${usd(f.outside_against_total)}</b>${outside(f.outside_against || [])}</div></div>
    <p class="tiny muted">Independent expenditures by super PACs, party committees and other groups (FEC Schedule E).</p>
    <h3 style="margin-top:10px">Fundraising over time</h3>
    ${historyChart([{ label: 'Cumulative raised', color: 'var(--accent)', points: (f.history || []).map((h) => ({ t: h.t, p: h.receipts_cum })) }, { label: 'Cash on hand', color: 'var(--muted)', dash: true, points: (f.history || []).filter((h) => h.cash != null).map((h) => ({ t: h.t, p: h.cash })) }])}`;
}

export function historyChart(series) {
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.p)));
  return lineChart(series, { yMax: max * 1.05, yFmt: (v) => `$${compact(v)}`, height: 180, title: 'Fundraising over time', padLeft: 50 });
}

/** Side-by-side comparison table for a race. matched: [{name, party, slug, finance}] */
export function comparison(fin, raceId) {
  if (!fin?.available) return notAvailable(fin?.reason || 'no finance data');
  const cols = fin.matched;
  if (!cols.length) return `<p class="small muted">No candidates are listed for this race yet, so FEC filers can't be matched. Top filers by money raised:</p>${filers(fin.others.slice(0, 6))}${financeSource(fin)}`;
  const rows = [
    ['Total raised', (f) => money(f?.receipts)],
    ['Total spent', (f) => money(f?.disbursements)],
    ['Cash on hand', (f) => money(f?.cash_on_hand)],
    ['Burn rate', (f) => (burnRate(f) === null ? '—' : pct(burnRate(f)))],
    ['Small donors (<$200)', (f) => (f?.detail ? money(f.small_individual) : '—')],
    ['Large individual donors', (f) => (f?.detail ? money(f.large_individual) : '—')],
    ['PACs', (f) => (f?.detail ? money(f.pac) : '—')],
    ['Self-funding', (f) => (f?.detail ? money((f.self_contributions || 0) + (f.self_loans || 0)) : '—')],
    ['In-state share (itemized)', (f) => (f?.detail && (f.itemized_in_state || f.itemized_out_state) ? pct(f.itemized_in_state / (f.itemized_in_state + f.itemized_out_state)) : '—')],
    ['Outside spending for', (f) => (f?.detail ? usd(f.outside_for_total) : '—')],
    ['Outside spending against', (f) => (f?.detail ? usd(f.outside_against_total) : '—')],
  ];
  return `<div class="table-scroll"><table><thead><tr><th></th>${cols.map((c) => `<th class="r"><a href="#/candidate/${encodeURIComponent(raceId)}/${encodeURIComponent(c.slug)}">${chip(c.party)} ${esc(c.name)}</a></th>`).join('')}</tr></thead><tbody>
    ${rows.map(([l, fn]) => `<tr><td>${esc(l)}</td>${cols.map((c) => `<td class="r num">${c.finance ? fn(c.finance) : '<span class="muted small">no FEC match</span>'}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    ${financeSource(fin)}
    ${fin.others.length ? `<details style="margin-top:6px"><summary class="small">Other FEC filers in this race (${fin.others.length})</summary><p class="tiny muted">The FEC lists everyone who filed for the seat, including candidates who lost primaries or withdrew.</p>${filers(fin.others)}</details>` : ''}
    ${fin.partial_error ? `<p class="tiny muted">Last refresh had an error: ${esc(fin.partial_error)}</p>` : ''}`;
}

function filers(list) {
  return `<table><tbody>${list.map((f) => `<tr><td class="small">${chip(f.party)} <a href="${esc(f.source_url)}" target="_blank" rel="noopener">${esc(f.name)}</a></td><td class="r num small">${money(f.receipts)} raised</td></tr>`).join('')}</tbody></table>`;
}
