// After election night: uncalled races, recount watch, runoffs, certification, expected vs. actual.
import { esc, num, pct, chip, statusTag, leadText, raceLink, patch, dateTimeET, PARTY_NAME, notAvailable } from '../ui.js';
import { starButton } from '../watch.js';

export function mount(root, ctx) {
  root.innerHTML = `<h1>After election night</h1>
    <p class="small muted">Races still being counted, recounts, runoffs and certification, and how pre-election expectations compared with the results.</p>
    <section class="panel" data-k="uncalled"></section>
    <div class="grid g2" style="margin-top:16px">
      <section class="panel" data-k="recount"></section>
      <section class="panel" data-k="runoffs"></section>
    </div>
    <section class="panel" style="margin-top:16px" data-k="cert"></section>
    <section class="panel" style="margin-top:16px" data-k="expected"></section>`;
  update(root, ctx, { force: true });
}

export function update(root, ctx, { force } = {}) {
  const a = ctx.state?.after;
  if (!a) return;
  patch(root, { uncalled: uncalled(a), recount: recount(a), runoffs: runoffs(a), cert: cert(a, ctx.state), expected: expected(a) }, force);
}

function uncalled(a) {
  const rows = a.uncalled;
  let html = `<header><h2>Uncalled races with votes counted (${rows.length})</h2><span class="small muted">Closest first</span></header>`;
  if (!rows.length) return html + '<p class="empty">No race has votes reported without a call.</p>';
  return html + `<div class="table-scroll"><table><thead><tr><th></th><th>Race</th><th>Status</th><th>Leader</th><th class="r">Margin</th><th class="r">Counted</th><th class="r">Votes left (implied)</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${starButton(r)}</td><td><a href="${raceLink(r)}"><b>${esc(r.label)}</b></a><div class="src">${esc(r.resultSource || '')} · ${esc(dateTimeET(r.resultFetchedAt))}</div></td><td>${statusTag(r)}</td><td class="small">${r.leader ? `${r.office === 'BM' ? '' : chip(r.leader.party)} ${esc(r.leader.name)} leading` : '—'}</td>
      <td class="r num">${r.marginPct != null ? `${r.marginPct.toFixed(2)} pts` : '—'}<div class="tiny muted">${r.marginVotes != null ? `${num(r.marginVotes)} votes` : ''}</div></td>
      <td class="r num">${r.pctExpected != null ? `${r.pctExpected}%` : '—'}<div class="tiny muted">${num(r.totalVotes)} votes</div></td>
      <td class="r num">${r.remainingImplied != null ? `≈ ${num(r.remainingImplied)}` : '<span class="muted">not available</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="tiny muted">"Votes left" is arithmetic on the source's own estimate of the share of expected votes counted (votes so far ÷ that share − votes so far). It is only as good as that estimate and is not a projection by this site.</p>`;
}

function recount(a) {
  const { rules, watch } = a.recount;
  let html = `<header><h2>Recount watch</h2>${rules.verified ? '' : '<span class="tag warn" title="Builder-compiled from state law; not checked against a live source">Unverified thresholds</span>'}</header>`;
  html += watch.length
    ? `<div class="table-scroll"><table><thead><tr><th>Race</th><th class="r">Margin</th><th>State rule</th></tr></thead><tbody>${watch.map((w) => `<tr><td><a href="#/race/${encodeURIComponent(w.id)}"><b>${esc(w.label)}</b></a><div>${w.within ? `<span class="tag warn">Within ${esc(w.rule.type)} recount margin</span>` : '<span class="tag">Within twice the margin</span>'}</div></td><td class="r num">${w.marginPct.toFixed(2)} pts<div class="tiny muted">${num(w.marginVotes)} votes</div></td><td class="small">${rule(w.rule)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">No counted race is within (or within twice) its state\'s recount margin.</p>';
  return html + `<details class="small" style="margin-top:8px"><summary>Thresholds used (${Object.keys(rules.states).length} states)</summary><ul>${Object.entries(rules.states).sort().map(([st, r]) => `<li><b>${esc(st)}</b>: ${rule(r)}</li>`).join('')}</ul><p class="tiny muted">States not listed have no automatic recount rule entered. ${esc(rules.source || '')}${rules.source_url ? ` · <a href="${esc(rules.source_url)}" target="_blank" rel="noopener">check</a>` : ''}. Correct in Admin.</p></details>`;
}
function rule(r) {
  return `${r.type === 'automatic' ? 'Automatic' : 'On request'} within ${r.margin_votes != null ? `${num(r.margin_votes)} votes` : `${r.margin_pct}%`}${r.note ? ` <span class="tiny muted">— ${esc(r.note)}</span>` : ''}${r.verified ? ' <span class="tag manual">Checked</span>' : ''}`;
}

function runoffs(a) {
  let html = '<header><h2>Runoff calendar</h2></header>';
  if (!a.runoffs.length) return html + '<p class="empty">No runoffs confirmed or possible yet.</p>';
  return html + `<ul class="feed" style="max-height:none">${a.runoffs.map((r) => `<li><a href="#/race/${encodeURIComponent(r.id)}"><b>${esc(r.label)}</b></a>
    ${r.confirmed ? `<span class="tag warn">Runoff${r.calledBy ? ` · per ${esc(r.calledBy)}` : ''}</span>` : r.possible ? `<span class="tag">Possible: leader at ${r.leaderPct?.toFixed(1)}%, majority required</span>` : ''}
    <div class="small">${r.date ? `Date: <b>${esc(r.date.date)}</b>${r.date.source_url ? ` <span class="src"><a href="${esc(r.date.source_url)}" target="_blank" rel="noopener">source</a></span>` : ''}` : '<span class="muted">Date not entered</span>'}</div>
    ${r.candidates ? `<div class="small">${r.candidates.map((c) => `${chip(c.party)} ${esc(c.name)}`).join(' vs. ')}</div>` : r.confirmed ? '' : ''}</li>`).join('')}</ul>`;
}

function cert(a, state) {
  const states = Object.entries(a.certification.states || {});
  let html = '<header><h2>Certification deadlines</h2></header>';
  if (!states.length) return html + notAvailable('no deadlines entered. They were not verified in this build; add each state\'s date with its source in Admin.');
  const today = new Date().toISOString().slice(0, 10);
  return html + `<div class="table-scroll"><table><thead><tr><th>State</th><th>Deadline</th><th>Certifying body</th></tr></thead><tbody>${states.sort((x, y) => x[1].date.localeCompare(y[1].date)).map(([st, c]) => `<tr style="${c.date < today ? 'opacity:.6' : ''}"><td><b>${esc(st)}</b></td><td class="num">${esc(c.date)}${c.date < today ? ' ✓' : ''}</td><td class="small">${esc(c.body || '—')} <span class="src"><a href="${esc(c.source_url)}" target="_blank" rel="noopener">source</a></span></td></tr>`).join('')}</tbody></table></div>`;
}

function expected(a) {
  const e = a.expected;
  const mark = (x) => (x === true ? '<span title="Favourite won">✓ matched</span>' : x === false ? '<b title="Favourite lost">✗ missed</b>' : '<span class="muted">—</span>');
  let html = `<header><h2>Expected vs. actual</h2><span class="small muted">Pre-election figures as of ${esc(dateTimeET(e.cutoff))}</span></header>`;
  if (!e.rows.length) return html + '<p class="empty">Filled in as races are called by a named outlet.</p>';
  const s = e.summary;
  const line = (n, t) => `${n}: <b>${t.hits}</b> favourite won, <b>${t.misses}</b> favourite lost`;
  html += `<p class="small">${line('Markets', s.market)} · ${line('Ratings', s.rating)} · ${line('Polling averages', s.poll)}</p>`;
  return html + `<div class="table-scroll"><table><thead><tr><th>Race</th><th>Winner (called)</th><th>Markets before the night</th><th>Latest rating</th><th>Polling average</th><th class="r">Final margin</th></tr></thead><tbody>
    ${e.rows.map((r) => `<tr><td><a href="#/race/${encodeURIComponent(r.id)}">${esc(r.label)}</a></td><td>${chip(r.winnerParty)} ${esc(r.winner)}<div class="tiny muted">${esc(r.calledBy)}</div></td>
      <td class="small">${r.market.fav ? `${r.market.pre.D !== undefined ? `D ${pct(r.market.pre.D)}` : ''} ${r.market.pre.R !== undefined ? `R ${pct(r.market.pre.R)}` : ''}<br>${mark(r.market.hit)}` : '<span class="muted">No pre-election market history</span>'}</td>
      <td class="small">${r.rating ? `${esc(r.rating.rating)} <span class="tiny muted">${esc(r.rating.outlet)}</span><br>${mark(r.rating.hit)}` : '<span class="muted">None entered</span>'}</td>
      <td class="small">${r.poll ? `${esc(r.poll.average)}, ${esc(r.poll.date)}<br>${mark(r.poll.hit)}` : '<span class="muted">None entered</span>'}</td>
      <td class="r num">${r.finalMarginPct != null ? `${r.finalMarginPct.toFixed(1)} pts` : '—'}<div class="tiny muted">${r.resultKind === 'certified' ? 'certified' : 'unofficial'}</div></td></tr>`).join('')}
    </tbody></table></div>
    <p class="tiny muted">"Favourite" means the side the market average priced higher (no favourite on a tie), the side a rating leaned to (toss-ups are not scored), or the polling-average leader. This compares what each source said with what happened; it is not a grade.</p>`;
}
