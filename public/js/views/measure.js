// Ballot measure page: what it does, who is on each side, money, live results and odds.
import { esc, pct, num, compact, src, patch, dateTimeET, STATUS_LABEL, notAvailable } from '../ui.js';
import { lineChart } from '../chart.js';

export async function mount(root, ctx) {
  root.innerHTML = `<div data-k="head"><p class="muted">Loading measure…</p></div>
    <div class="grid g2" style="margin-top:12px">
      <section class="panel" aria-label="What it does"><div data-k="about"></div></section>
      <section class="panel" aria-label="Live results"><div data-k="results"></div></section>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <section class="panel" aria-label="Supporters and opponents"><div data-k="sides"></div></section>
      <section class="panel" aria-label="Market odds"><div data-k="odds"></div></section>
    </div>`;
  await update(root, ctx, { force: true });
}

export async function update(root, ctx, { force } = {}) {
  const r = await fetch(`/api/race/${encodeURIComponent(ctx.params.id)}`);
  if (!r.ok) {
    root.innerHTML = `<p>Unknown ballot measure <code>${esc(ctx.params.id)}</code>. Measures are added from the research file or in Admin. <a href="#/races">All races</a></p>`;
    return;
  }
  const d = await r.json();
  document.title = `${d.label} — Midterm Live`;
  patch(root, { head: head(d), about: about(d), results: results(d), sides: sides(d), odds: odds(d) }, force);
}

const link = (u, t = 'source') => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>` : '');

function head(d) {
  const m = d.measure;
  const passed = d.call ? (/^yes/i.test(d.call.winner) ? 'Passed' : 'Failed') : null;
  return `<p class="small"><a href="#/races">← All races</a></p>
    <h1>${esc(d.stateName)} ${esc(m.number)}</h1>
    <p style="margin:2px 0 6px">${esc(m.title)}</p>
    <div class="status-line"><span class="tag">Ballot measure</span><span class="tag">${esc(d.stateName)}</span>
      ${passed ? `<span class="tag called">${passed} · called by ${esc(d.call.calledBy)}</span>` : `<span class="tag">${esc(STATUS_LABEL[d.status] || d.status)}</span>`}
      <span class="src">Entry from ${esc(m.origin)}</span></div>`;
}

function about(d) {
  const m = d.measure;
  return `<header><h2>What it does</h2></header>
    ${m.summary ? `<p>${esc(m.summary)}</p><div class="src">${link(m.summary_source_url, 'Official text or summary')}</div>` : notAvailable('no plain-language summary has been entered yet')}
    <dl class="kv" style="margin-top:10px"><dt>To pass</dt><dd>${m.threshold && m.threshold !== 'majority' ? `${esc(m.threshold)} Yes vote required` : 'Simple majority (more Yes than No)'}</dd></dl>`;
}

function results(d) {
  const p = d.results.primary;
  let html = `<header><h2>Results</h2>${p ? `<span class="tag">${p.kind === 'certified' ? 'Certified' : 'Unofficial count'}</span>` : ''}</header>`;
  if (!p) return html + notAvailable('no results feed is reporting this measure yet');
  const yes = p.candidates.find((c) => /^yes/i.test(c.name));
  const no = p.candidates.find((c) => /^no/i.test(c.name));
  const need = d.measure.need;
  const row = (c, color) => (c ? `<div class="res-row"><span class="name">${esc(c.name)}</span><span class="num">${num(c.votes)}</span><span class="num" style="min-width:4.5em;text-align:right"><b>${c.pct != null ? c.pct.toFixed(1) + '%' : '—'}</b></span><span class="bar"><span style="width:${c.pct || 0}%;background:${color}"></span></span></div>` : '');
  html += `<div class="small">${p.pctExpected != null ? `<b>${p.pctExpected}%</b> of expected vote counted` : 'Share of expected vote counted: not available'} · ${num(p.total)} votes</div>`;
  html += `<div style="position:relative">${row(yes, 'var(--accent)')}${row(no, 'var(--muted)')}</div>`;
  if (need !== 0.5) html += `<p class="small">Pass line: <b>${(need * 100).toFixed(0)}% Yes</b>.</p>`;
  if (d.measure.thresholdNote) html += `<div class="callout warn">${esc(d.measure.thresholdNote)}</div>`;
  if (yes && no && p.total && !d.call) html += `<p class="small">${yes.votes >= no.votes ? 'Yes' : 'No'} leading — not called.</p>`;
  return html + `<div style="margin-top:6px">${src({ source: p.source === 'Manual' ? `Manual entry — ${p.manual_source}` : p.source, source_url: p.source_url, fetched_at: p.fetched_at, stale: p.stale, manual: p.manual })}</div>`;
}

function sides(d) {
  const m = d.measure;
  const list = (arr) => (arr?.length ? `<ul class="feed" style="max-height:none">${arr.map((s) => `<li>${esc(s.name)} <span class="src">${link(s.source_url)}</span></li>`).join('')}</ul>` : '<p class="empty">None entered.</p>');
  const money = (f) => (f ? `<p class="small"><b>Raised: $${compact(f.raised)}</b>${f.spent != null ? ` · spent $${compact(f.spent)}` : ''}<br><span class="src">${link(f.source_url, f.source || 'source')} · as of ${esc(f.as_of)}</span></p>` : '<p class="small muted">Money raised: not entered (state disclosure).</p>');
  return `<header><h2>Supporters and opponents</h2></header><div class="row2">
    <div><h3>Support (Yes)</h3>${money(m.finance?.support)}${list(m.supporters)}</div>
    <div><h3>Oppose (No)</h3>${money(m.finance?.oppose)}${list(m.opponents)}</div></div>`;
}

function odds(d) {
  const o = d.odds;
  let html = '<header><h2>Market odds</h2><span class="small muted">Market-implied chance, not a forecast</span></header>';
  if (!o.n) return html + notAvailable('no Kalshi or Polymarket market was matched to this measure');
  html += `<p><b>Passes:</b> ${pct(o.avg.Y)} · <b>Fails:</b> ${pct(o.avg.N)} <span class="tiny muted">(average of ${o.n} market${o.n > 1 ? 's' : ''})</span></p>`;
  html += o.sources.map((s) => `<div class="small" style="margin-top:6px"><b>${esc(s.source)}</b>: ${s.outcomes.map((x) => `${esc(x.label)} ${pct(x.price, 1)}`).join(' · ')}${s.low_volume ? ' <span class="tag warn">Low volume</span>' : ''}<br>${src(s)}</div>`).join('');
  const pts = d.oddsHistory.filter((r) => r.party === 'Y' || /yes|pass/i.test(r.label || '')).map((r) => ({ t: r.t, p: r.p }));
  return html + lineChart([{ label: 'Chance it passes', color: 'var(--accent)', points: pts }], { height: 150, title: 'Pass odds over time' });
}
