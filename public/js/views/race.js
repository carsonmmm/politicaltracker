import { esc, pct, num, compact, chip, statusTag, leadText, oddsText, oddsBar, src, patch, dateTimeET, PARTY_NAME, OFFICE_NAME, STATUS_LABEL, notAvailable } from '../ui.js';
import { lineChart } from '../chart.js';
import { renderCountyMap } from '../map.js';
import { comparison } from '../finance.js';
import * as measureView from './measure.js';

const FIPS = { AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56' };
let detail = null;

export async function mount(root, ctx) {
  if (ctx.params.id.startsWith('BM-')) return measureView.mount(root, ctx);
  moreSet = false;
  root.innerHTML = `<div data-k="head"><p class="muted">Loading race…</p></div>
    <div class="grid g2" style="margin-top:12px">
      <section class="panel" aria-label="Live results"><div data-k="results"></div></section>
      <section class="panel" aria-label="Market odds"><div data-k="odds"></div></section>
    </div>
    <div class="grid g3" style="margin-top:16px">
      <section class="panel" aria-label="Candidates"><div data-k="cands"></div></section>
      <section class="panel" aria-label="Ratings and polls"><div data-k="ratings"></div></section>
      <section class="panel" aria-label="Race details"><div data-k="facts"></div></section>
    </div>
    <details id="more" class="more" style="margin-top:16px">
    <summary data-k="more-sum">More about this race</summary>
    <section class="panel" style="margin-top:12px" aria-label="Past results"><div data-k="past"></div></section>
    <div class="grid g2" style="margin-top:16px">
      <section class="panel" aria-label="County results"><header><h2>County results</h2></header><div class="map-wrap" id="county" style="min-height:60px"></div><div data-k="county-src"></div></section>
      <section class="panel" aria-label="Odds history"><header><h2>Odds history</h2><span class="src">Market-implied chance over time</span></header><div data-k="ohist"></div></section>
    </div>
    <section class="panel" style="margin-top:16px" aria-label="Head-to-head"><div data-k="h2h"></div></section>
    <div class="grid g2" style="margin-top:16px">
      <section class="panel" aria-label="Campaign finance comparison"><div data-k="money"></div></section>
      <section class="panel" aria-label="Outside spending"><div data-k="outside"></div></section>
    </div>
    <section class="panel" style="margin-top:16px" aria-label="Key moments"><div data-k="moments"></div></section>
    </details>`;
  await load(root, ctx, true);
}

export async function update(root, ctx, opts = {}) {
  if (ctx.params.id.startsWith('BM-')) return measureView.update(root, ctx, opts);
  await load(root, ctx, opts.force);
}

let moreSet = false;

let lastCountyKey = '';
async function load(root, ctx, force) {
  const r = await fetch(`/api/race/${encodeURIComponent(ctx.params.id)}`);
  if (!r.ok) {
    root.innerHTML = `<p>Unknown race <code>${esc(ctx.params.id)}</code>. <a href="#/races">All races</a></p>`;
    return;
  }
  detail = await r.json();
  const d = detail;
  document.title = `${d.label} — Midterm Live`;
  if (!moreSet) {
    // Tier 1 and 2: everything open. Tier 3: basic card; the rest stays one click away.
    root.querySelector('#more').open = d.tier < 3;
    moreSet = true;
  }
  patch(root, { 'more-sum': d.tier < 3 ? 'More about this race' : 'Tier 3 (safe or unrated) race: basic card shown. Open for past results, county map, odds history, head-to-head, finance and key moments', past: pastResults(d) }, force);
  patch(root, { head: head(d), results: results(d), odds: odds(d), ohist: oddsHistory(d), cands: candidates(d), ratings: ratings(d), facts: facts(d), h2h: headToHead(d), money: money(d), outside: outside(d), moments: moments(d) }, force);
  const p = d.results.primary;
  const cKey = JSON.stringify(p?.counties || []);
  const el = root.querySelector('#county');
  if (d.office === 'H') {
    el.innerHTML = '<p class="empty">Not shown for House districts (county lines do not match district lines).</p>';
  } else if (!p?.counties?.length) {
    el.innerHTML = notAvailable(p ? `${p.source} did not provide county-level results` : 'no results feed is reporting this race');
    lastCountyKey = '';
  } else if (force || cKey !== lastCountyKey) {
    lastCountyKey = cKey;
    await renderCountyMap(el, FIPS[d.state], p.counties);
    patch(root, { 'county-src': src({ source: p.source, source_url: p.source_url, fetched_at: p.fetched_at, stale: p.stale }) }, force);
  }
}

function head(d) {
  const r = d.race;
  const where = r.office === 'H' ? `${r.stateName}, ${r.district === 0 ? 'at-large district' : `district ${r.district}`}` : r.stateName;
  return `<p class="small"><a href="#/races">← All races</a></p>
    <h1>${esc(d.label)}</h1>
    <div class="status-line">
      <span class="tag">${esc(OFFICE_NAME[r.office])}${r.special ? ' · Special election' : ''}</span>
      <span class="tag">${esc(where)}</span>
      <span class="tag ${d.tier === 1 ? 't1' : ''}" title="${esc(d.tierReasons.join('; '))}">Tier ${d.tier}</span>
      ${statusTag(d)}
    </div>
    <p class="small muted">Tier reason: ${esc(d.tierReasons.join('; '))}</p>`;
}

function results(d) {
  const { primary: p, alternates, disagreement, majorityNote } = d.results;
  let html = `<header><h2>Results</h2>${p ? `<span class="tag ${p.kind === 'certified' ? 'called' : ''}">${p.kind === 'certified' ? 'Certified' : 'Unofficial count'}</span>` : ''}</header>`;
  if (!p) {
    return html + notAvailable('no results feed is reporting this race. AP and Decision Desk HQ need paid keys; the research file and manual entries have nothing for it yet.') + outstanding(d);
  }
  html += `<div class="status-line"><span class="big-status">${esc(STATUS_LABEL[d.status] || d.status)}</span>${d.status === 'called' && d.call ? `<span>— ${chip(d.call.party)} <b>${esc(d.call.winner)}</b>, called by <b>${esc(d.call.calledBy)}</b> at ${esc(dateTimeET(d.call.calledAt))}</span>` : ''}</div>`;
  html += `<div class="small">${p.pctExpected != null ? `<b>${p.pctExpected}%</b> of expected vote counted (estimate from ${esc(p.source === 'Manual' ? p.manual_source : p.source)})` : 'Share of expected vote counted: not available from this source'} · ${num(p.total)} votes</div>`;
  if (!p.total) html += '<p class="empty">No votes reported yet.</p>';
  html += p.candidates.map((c) => {
    const isWinner = d.call && d.call.winner === c.name;
    const color = c.party === 'D' ? 'var(--dem)' : c.party === 'R' ? 'var(--rep)' : 'var(--oth)';
    return `<div class="res-row"><span class="name ${isWinner ? 'winner' : ''}">${chip(c.party)} ${esc(c.name)}${c.incumbent ? ' <span class="tag">Incumbent</span>' : ''}${isWinner ? ` <span class="tag called">Winner · ${esc(d.call.calledBy)}</span>` : p.leader && p.leader.name === c.name && p.total ? ' <span class="tag">Leading</span>' : ''}</span>
      <span class="num">${num(c.votes)}</span><span class="num" style="min-width:4.5em;text-align:right"><b>${c.pct != null ? c.pct.toFixed(1) + '%' : '—'}</b></span>
      <span class="bar"><span style="width:${c.pct || 0}%;background:${color}"></span></span></div>`;
  }).join('');
  if (p.marginPct != null && p.total) html += `<p class="small">Margin: <b>${p.marginPct.toFixed(1)} pts</b>${d.status !== 'called' ? ' — leading, not called' : ''}</p>`;
  if (majorityNote) html += `<div class="callout warn">${esc(majorityNote)}</div>`;
  if (p.rcvRounds?.length) html += rcv(p.rcvRounds);
  else if (d.race.format?.rcv) html += '<p class="small muted">Ranked-choice race: tabulation rounds will appear here once released.</p>';
  html += `<div style="margin-top:8px">${src({ source: p.source === 'Manual' ? `Manual entry — ${p.manual_source}` : p.source, source_url: p.source_url, fetched_at: p.fetched_at, stale: p.stale, manual: p.manual, extra: p.from_snapshot ? ' <span class="tag stale">Last saved snapshot — feed down</span>' : '' })}</div>`;
  if (disagreement) html += `<div class="callout warn"><b>Sources disagree:</b> ${esc(disagreement)}</div>`;
  if (alternates.length) {
    html += `<details style="margin-top:8px"><summary>Other sources (${alternates.length})</summary>${alternates.map((a) => `<div class="small" style="margin:6px 0"><b>${esc(a.source)}</b>: ${a.candidates.map((c) => `${esc(c.name)} ${num(c.votes)}`).join(', ')}${a.call ? ` — called for ${esc(a.call.winner)} by ${esc(a.call.calledBy)}` : ''}<br>${src(a)}</div>`).join('')}</details>`;
  }
  return html + outstanding(d);
}

function outstanding(d) {
  const p = d.results.primary;
  const note = p?.outstanding_note || d.notes?.text;
  return `<div class="callout"><b>Ballots still out:</b> ${note ? esc(note) : 'No source has said which ballots remain for this race.'}
    <div class="tiny muted" style="margin-top:4px">Mail, early and Election Day votes are often counted at different times and can lean differently, so early leads can shift.</div>
    ${d.notes?.source_url ? `<div class="src"><a href="${esc(d.notes.source_url)}" target="_blank" rel="noopener">source</a></div>` : ''}</div>`;
}

function rcv(rounds) {
  const names = [...new Set(rounds.flatMap((r) => r.candidates.map((c) => c.name)))];
  return `<h3 style="margin-top:12px">Ranked-choice rounds</h3><div class="table-scroll"><table><thead><tr><th>Candidate</th>${rounds.map((r) => `<th class="r">Round ${r.round}</th>`).join('')}</tr></thead><tbody>${names.map((n) => `<tr><td>${esc(n)}</td>${rounds.map((r) => { const c = r.candidates.find((x) => x.name === n); return `<td class="r num">${c ? num(c.votes) : '<span class="muted">eliminated</span>'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function odds(d) {
  const o = d.odds;
  let html = `<header><h2>Market odds</h2><span class="small muted">Market-implied chance, not a forecast</span></header>`;
  if (!o.n) return html + notAvailable('no Kalshi or Polymarket market was matched to this race, or the market feeds are unreachable. Map a market in Admin if one exists.');
  html += `<div style="margin-bottom:6px"><b>Average:</b> ${oddsText(o.avg)}</div>${oddsBar(o.avg)}`;
  html += o.sources.map((s) => `<div style="margin-top:12px"><h3>${esc(s.source)} <span class="small muted">— ${esc(s.title)}</span></h3>
    <div class="table-scroll"><table><thead><tr><th>Outcome</th><th class="r">Chance</th><th class="r">Volume</th></tr></thead><tbody>
    ${s.outcomes.map((x) => `<tr><td>${x.party ? chip(x.party) : ''} ${esc(x.label)}</td><td class="r num"><b>${pct(x.price, 1)}</b></td><td class="r num">${x.volume != null ? `${s.volume_unit === 'USD' ? '$' : ''}${compact(x.volume)}${s.volume_unit === 'contracts' ? ' contracts' : ''}` : '—'}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="small">Total volume: <b>${s.volume_unit === 'USD' ? '$' : ''}${compact(s.volume)}${s.volume_unit === 'contracts' ? ' contracts' : ''}</b>${s.low_volume ? ' <span class="tag warn" title="Thin markets can be moved by small trades">Low volume — less reliable</span>' : ''}</div>
    ${src({ source: s.source, source_url: s.source_url, fetched_at: s.fetched_at, stale: s.stale, extra: s.from_snapshot ? ' <span class="tag stale">Last saved snapshot</span>' : '' })}</div>`).join('');
  return html;
}

const COLORS = { D: 'var(--dem)', R: 'var(--rep)', O: 'var(--oth)' };
function oddsHistory(d) {
  const groups = new Map();
  for (const r of d.oddsHistory) {
    const k = `${r.source}|${r.party || r.label}`;
    if (!groups.has(k)) groups.set(k, { label: `${r.source}: ${r.party ? PARTY_NAME[r.party] : r.label}`, color: COLORS[r.party] || 'var(--muted)', dash: r.source === 'Polymarket', points: [] });
    groups.get(k).points.push({ t: r.t, p: r.p });
  }
  return lineChart([...groups.values()], { title: `Odds history for ${d.label}` }) + '<p class="tiny muted">Solid lines: Kalshi. Dashed: Polymarket. History before this server started is backfilled from each market\'s price history where available.</p>';
}

function candidates(d) {
  let html = '<header><h2>Candidates</h2></header>';
  if (!d.candidates.length) return html + notAvailable('no candidate list has been loaded for this race. Candidates come from the results feed, the research file, or Admin entries.');
  html += `<ul class="feed">${d.candidates.map((c) => `<li>${chip(c.party)} <a href="${profileHref(d, c.name)}"><b>${esc(c.name)}</b></a>${c.incumbent ? ' <span class="tag">Incumbent</span>' : ''} <span class="small muted">${esc(PARTY_NAME[c.party] || c.party_label || 'Other')}</span><div class="src">${c.source_url ? `<a href="${esc(c.source_url)}" target="_blank" rel="noopener">${esc(c.source || c.origin)}</a>` : esc(c.source || c.origin)}</div></li>`).join('')}</ul>`;
  return html + '<p class="tiny muted">Open a name for the full profile: biography, positions, endorsements and finance.</p>';
}

function ratings(d) {
  let html = '<header><h2>Ratings &amp; polling</h2></header>';
  html += d.ratings.length
    ? `<table><thead><tr><th>Outlet</th><th>Rating</th><th>Date</th></tr></thead><tbody>${d.ratings.map((r) => `<tr><td><a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.outlet)}</a></td><td>${esc(r.rating)}</td><td class="num">${esc(r.date)}</td></tr>`).join('')}</tbody></table>`
    : notAvailable('no expert ratings have been entered. Ratings are dated snapshots added in Admin.');
  html += '<h3 style="margin-top:12px">Polling average</h3>';
  const latest = [...d.polls].sort((a, b) => b.date.localeCompare(a.date))[0];
  html += latest
    ? `<p class="small">${latest.values.map((v) => `${esc(v.name)} <b>${v.pct}%</b>`).join(' · ')}<br><span class="src"><a href="${esc(latest.source_url)}" target="_blank" rel="noopener">${esc(latest.average)}</a> · as of ${esc(latest.date)}</span></p>`
    : notAvailable('no polling average has been entered.');
  return html;
}

function facts(d) {
  const f = d.race.format || {};
  const notes = [];
  if (f.rcv) notes.push('Ranked-choice voting: results are shown by tabulation round when released.');
  if (f.topTwo) notes.push('Top-two system: both general-election candidates can be from the same party.');
  if (f.majorityRequired) notes.push(`A candidate needs a majority to avoid a runoff${f.runoffDate ? ` (runoff ${esc(f.runoffDate)})` : ' (runoff date not entered)'}.`);
  return `<header><h2>About this race</h2></header>
    <dl class="kv">
      <dt>Poll close</dt><dd>${d.pollClose ? `${esc(d.pollClose.first)}${d.pollClose.last !== d.pollClose.first ? `–${esc(d.pollClose.last)}` : ''} ET <span class="tag warn">Unverified</span>` : '—'}</dd>
      <dt>Format</dt><dd>${notes.length ? notes.map(esc).join('<br>') : 'Plurality winner'}${f.note ? `<br><span class="small muted">${esc(f.note)}</span>` : ''}${Object.keys(f).length ? ' <span class="tag warn">Unverified</span>' : ''}</dd>
      <dt>Past results</dt><dd>${d.past?.available ? `${d.past.elections.map((e) => { const w = e.candidates[0]; const t = e.totalvotes || 1; return `${e.year}: ${w.party} ${((w.votes / t) * 100).toFixed(0)}%`; }).join(' · ')} <span class="tiny muted">(see below)</span>` : `<span class="muted">${esc(d.past?.reason || 'Not available')}</span>`}</dd>
      <dt>Partisan lean</dt><dd>${d.lean?.length ? d.lean.map((l) => `${esc(l.value)} <span class="tiny muted">${esc(l.source)}</span>`).join(' · ') : '<span class="muted">Not entered</span>'}</dd>
      <dt>Seat list</dt><dd><a href="${esc(d.race.catalog_source_url)}" target="_blank" rel="noopener">Ballotpedia</a></dd>
    </dl>`;
}

function profileHref(d, name) {
  const p = d.profiles.find((x) => x.name === name);
  return p ? `#/candidate/${encodeURIComponent(d.id)}/${encodeURIComponent(p.slug)}` : '#';
}

function headToHead(d) {
  const ps = d.profiles;
  let html = '<header><h2>Head-to-head</h2><span class="small muted">Same issues for every candidate, from their own statements</span></header>';
  if (ps.length < 2) return html + notAvailable(ps.length ? 'only one candidate is listed for this race so far' : 'no candidates are listed for this race yet');
  const issues = Object.keys(ps[0].positions);
  const cell = (x) => (x.status === 'stated' ? `${esc(x.summary)}<div class="src"><a href="${esc(x.source_url)}" target="_blank" rel="noopener">statement</a></div>` : x.status === 'none' ? 'No stated position found.' : '<span class="muted">Not yet researched</span>');
  return html + `<div class="table-scroll"><table><thead><tr><th>Issue</th>${ps.map((p) => `<th><a href="${profileHref(d, p.name)}">${chip(p.party)} ${esc(p.name)}</a></th>`).join('')}</tr></thead><tbody>
    ${issues.map((k) => `<tr><td><b>${esc(ps[0].positions[k].label)}</b></td>${ps.map((p) => `<td class="small" style="min-width:180px">${cell(p.positions[k])}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
}

function money(d) {
  return `<header><h2>Campaign finance</h2><span class="small muted">Raw figures, no score or grade</span></header>${comparison(d.finance, d.id)}`;
}

function outside(d) {
  let html = '<header><h2>Outside spending</h2><span class="small muted">Super PACs, parties and groups (FEC Schedule E)</span></header>';
  const f = d.finance;
  if (!f?.available) return html + notAvailable(f?.reason || 'no finance data');
  const rows = f.matched.filter((m) => m.finance);
  if (!rows.length) return html + notAvailable('no candidate in this race is matched to an FEC filing yet');
  if (!rows.some((m) => m.finance.detail)) return html + notAvailable('outside-spending detail needs a free FEC_API_KEY (DEMO_KEY only allows summaries)');
  const list = (l) => (l?.length ? `<ol class="small" style="padding-left:18px;margin:2px 0 8px">${l.slice(0, 5).map((s) => `<li>${esc(s.name)} — $${compact(s.total)}</li>`).join('')}</ol>` : '<p class="small muted" style="margin:2px 0 8px">None reported.</p>');
  return html + rows.map((m) => `<div style="margin-bottom:10px"><h3>${chip(m.party)} ${esc(m.name)}</h3>
    <div class="row2"><div><b>For: $${compact(m.finance.outside_for_total || 0)}</b>${list(m.finance.outside_for)}</div><div><b>Against: $${compact(m.finance.outside_against_total || 0)}</b>${list(m.finance.outside_against)}</div></div></div>`).join('');
}

const MOMENT_LABEL = { debate: 'Debate', ad: 'Ad', endorsement: 'Endorsement', controversy: 'Controversy', event: 'Event', other: 'Other' };
function moments(d) {
  let html = '<header><h2>Key moments</h2><span class="small muted">Each entry links to its source; the same standard applies to every candidate</span></header>';
  if (!d.moments.length) return html + notAvailable('no key moments have been entered for this race');
  return html + `<ul class="feed" style="max-height:none">${d.moments.map((m) => `<li><span class="num small muted">${esc(m.date)}</span> <span class="tag">${esc(MOMENT_LABEL[m.type] || m.type)}</span> ${esc(m.text)} <span class="src"><a href="${esc(m.source_url)}" target="_blank" rel="noopener">source</a>${m.origin === 'Manual' ? ' <span class="tag manual">Manual</span>' : ''}</span></li>`).join('')}</ul>`;
}

function pastResults(d) {
  const p = d.past;
  let html = '<header><h2>Past results and partisan lean</h2></header>';
  const lean = d.lean?.length ? `<p class="small"><b>Partisan lean:</b> ${d.lean.map((l) => `${esc(l.value)} <span class="src"><a href="${esc(l.source_url)}" target="_blank" rel="noopener">${esc(l.source)}</a>${l.date ? `, ${esc(l.date)}` : ''}</span>`).join(' · ')}</p>`
    : '<p class="small muted">Partisan lean: not entered. Cook PVI is proprietary, so it is added by hand in Admin with its source.</p>';
  if (!p?.available) return html + lean + notAvailable(p?.reason || 'no past results loaded');
  const rows = p.elections.map((e) => {
    const tot = e.totalvotes || e.candidates.reduce((a, c) => a + c.votes, 0);
    const top = e.candidates.slice(0, 3);
    return `<tr><td class="num">${esc(e.year)}${e.special ? ' <span class="tag">Special</span>' : ''}</td><td>${top.map((c) => `${chip(c.party)} ${esc(c.name)} <span class="num">${tot ? ((c.votes / tot) * 100).toFixed(1) : '—'}%</span>`).join('<br>')}</td><td class="r num">${num(tot)}</td></tr>`;
  }).join('');
  const pres = p.president?.length ? `<h3 style="margin-top:10px">Presidential vote in ${esc(d.stateName)}</h3><table><tbody>${p.president.map((e) => { const tot = e.totalvotes; return `<tr><td class="num">${esc(e.year)}</td><td>${e.candidates.slice(0, 2).map((c) => `${chip(c.party)} ${esc(c.name)} <span class="num">${tot ? ((c.votes / tot) * 100).toFixed(1) : '—'}%</span>`).join(' · ')}</td></tr>`; }).join('')}</tbody></table>` : '';
  return html + lean + `<div class="table-scroll"><table><thead><tr><th>Year</th><th>Top finishers</th><th class="r">Total votes</th></tr></thead><tbody>${rows}</tbody></table></div>${pres}
    ${d.office === 'H' ? '<p class="tiny muted">District lines may have changed since these elections, including mid-decade redistricting in some states before 2026, so past results may describe a different district.</p>' : ''}
    <div class="src" style="margin-top:6px"><a href="${esc(p.source_url)}" target="_blank" rel="noopener">${esc(p.source)}</a> · loaded ${esc(String(p.fetched_at).slice(0, 10))}</div>`;
}
