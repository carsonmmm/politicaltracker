import { esc, pct, chip, statusTag, leadText, oddsBar, oddsText, raceLink, timeET, dateTimeET, src, patch, PARTY_NAME, OFFICE_NAME } from '../ui.js';
import { renderStateMap, colorFor } from '../map.js';
import { watched } from '../watch.js';

export async function mount(root, ctx) {
  root.innerHTML = `
    <h1 class="sr-only">Midterm Live dashboard</h1>
    <div class="grid g3" style="margin-bottom:16px">
      <section class="panel" data-k="bop-senate" aria-label="Senate balance of power"></section>
      <section class="panel" data-k="bop-house" aria-label="House balance of power"></section>
      <section class="panel" data-k="bop-gov" aria-label="Governors balance"></section>
    </div>
    <div class="grid g2">
      <section class="panel" aria-label="Map">
        <header><h2>Map</h2><span class="src" data-k="map-src"></span></header>
        <div class="toggles">
          <div class="seg" role="group" aria-label="Office">
            ${['S', 'H', 'G'].map((o) => `<button type="button" data-office="${o}">${OFFICE_NAME[o]}</button>`).join('')}
          </div>
          <div class="seg" role="group" aria-label="Colour by">
            ${[['called', 'Called'], ['leader', 'Leader'], ['odds', 'Market odds'], ['rating', 'Rating']].map(([m, l]) => `<button type="button" data-mode="${m}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="map-wrap" id="map" style="min-height:200px"></div>
        <div class="legend" data-k="map-legend" style="margin-top:6px"></div>
      </section>
      <div class="grid" style="align-content:start">
        <section class="panel" aria-label="Poll closings" data-k="polls"></section>
        <section class="panel" aria-label="Latest calls"><header><h2>Latest calls</h2><span class="src">Only races called by a named outlet</span></header><div data-k="calls"></div></section>
        <section class="panel" aria-label="Chamber control odds" data-k="control"></section>
      </div>
    </div>
    <section style="margin-top:16px" aria-label="Key races">
      <header style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px"><h2>Key races (Tier 1) and your watchlist</h2><a class="small" href="#/races">All races →</a></header>
      <div data-k="strip"></div>
    </section>`;
  root.querySelectorAll('[data-office]').forEach((b) => b.addEventListener('click', () => { ctx.ui.mapOffice = b.dataset.office; ctx.saveUi(); drawMap(root, ctx, true); }));
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { ctx.ui.mapMode = b.dataset.mode; ctx.saveUi(); drawMap(root, ctx, true); }));
  update(root, ctx, { force: true });
}

export function update(root, ctx, { force = false } = {}) {
  const s = ctx.state;
  if (!s) return;
  const b = s.balance;
  patch(root, {
    'bop-senate': bop('Senate', b.senate, b.baseline, 'seats'),
    'bop-house': bop('House', b.house, b.baseline, 'seats'),
    'bop-gov': bop('Governors', b.governors, b.baseline, 'governorships'),
    calls: calls(s),
    control: control(s),
    strip: strip(s),
    polls: polls(s),
  }, force);
  drawMap(root, ctx, force);
}

export function tick(root, ctx) {
  const el = root.querySelector('[data-k="countdown"]');
  if (el && ctx.state) el.textContent = countdownText(nextClose(ctx.state.pollClosing).at);
}

let lastMapKey = '';
async function drawMap(root, ctx, force) {
  const { mapOffice: office, mapMode: mode } = ctx.ui;
  root.querySelectorAll('[data-office]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.office === office)));
  root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  const races = ctx.state.races.filter((r) => r.office === office);
  const key = JSON.stringify([office, mode, races.map((r) => [r.status, r.call?.party, r.leader?.party, r.odds, r.rating?.rating])]);
  if (!force && key === lastMapKey) return;
  lastMapKey = key;
  const el = root.querySelector('#map');
  if (office === 'H') {
    el.innerHTML = houseGrid(races, mode);
  } else {
    const byState = Object.fromEntries(races.map((r) => [r.state, r]));
    await renderStateMap(el, byState, mode, { onClick: (id) => (location.hash = `#/race/${encodeURIComponent(id)}`) });
  }
  const legends = {
    called: [['--dem', 'Democrat winner (called)'], ['--rep', 'Republican winner (called)'], ['--oth', 'Other winner'], ['--none', 'Not called']],
    leader: [['--dem', 'D called'], ['--dem-soft', 'D leading'], ['--rep-soft', 'R leading'], ['--rep', 'R called'], ['--none', 'No votes']],
    odds: [['--dem', 'D favoured by markets'], ['--none', 'Even / no market'], ['--rep', 'R favoured by markets']],
    rating: [['--dem', 'Rated D'], ['--oth-soft', 'Toss-up'], ['--rep', 'Rated R'], ['--none', 'No rating entered']],
  };
  patch(root, {
    'map-legend': legends[mode].map(([v, l]) => `<span><i style="background:var(${v})"></i>${esc(l)}</span>`).join('') + '<span>Labels: ✓ called, + leading, number = market-implied %</span>',
    'map-src': mode === 'odds' ? 'Market-implied chance: average of Kalshi and Polymarket' : mode === 'rating' ? 'Latest entered rating per race' : 'Results feed (see each race for source)',
  }, true);
}

function houseGrid(races, mode) {
  const byState = new Map();
  for (const r of races) {
    if (!byState.has(r.state)) byState.set(r.state, []);
    byState.get(r.state).push(r);
  }
  return `<p class="small muted">District shapes are not bundled, so each square is one district, grouped by state. Hover or focus a square for details.</p><div class="house-grid">${[...byState.entries()].map(([st, rs]) => `<div class="st"><b>${st}</b><div class="cells">${rs.map((r) => {
    const c = colorFor(r, mode);
    return `<a class="cell" href="${raceLink(r)}" style="background:${c.fill}" title="${esc(`${r.label}: ${c.label}`)}" aria-label="${esc(`${r.label}: ${c.label}`)}">${esc(c.short.replace(/\d+/, '').slice(0, 2))}</a>`;
  }).join('')}</div></div>`).join('')}</div>`;
}

function bop(title, c, baseline, unit) {
  const D = c.not_up.D + c.called.D, R = c.not_up.R + c.called.R, O = (c.not_up.I || 0) + c.called.O;
  const segs = [
    ['D', D, `Democrats: ${c.not_up.D} not up + ${c.called.D} called`],
    ['Dl', c.leading.D, `Democrats leading in ${c.leading.D} uncalled`],
    ['O', O, `Others: ${O}`],
    ['Ol', c.leading.O, `Others leading: ${c.leading.O}`],
    ['U', c.uncalled, `No votes reported: ${c.uncalled}`],
    ['Rl', c.leading.R, `Republicans leading in ${c.leading.R} uncalled`],
    ['R', R, `Republicans: ${c.not_up.R} not up + ${c.called.R} called`],
  ];
  const bar = segs.filter(([, n]) => n > 0).map(([k, n, l]) => `<span class="seg-${k}" style="width:${(n / c.total) * 100}%" title="${esc(l)}"></span>`).join('');
  const tie = c.tiebreak ? `<div class="tiny muted">${esc(c.tiebreak.note)}</div>` : '';
  return `<div class="bop"><header><h2>${title}</h2><span class="small muted">${c.majority} for majority</span></header>
    <div class="row"><span class="pD"><b>D ${D}</b> called/holdover · ${c.leading.D} leading</span><span class="pR">${c.leading.R} leading · <b>R ${R}</b> called/holdover</span></div>
    <div class="bar" role="img" aria-label="${esc(`${title}: Democrats ${D} called or not up, ${c.leading.D} leading; Republicans ${R} called or not up, ${c.leading.R} leading; ${c.uncalled} with no votes; ${c.majority} needed for majority`)}">${bar}<span class="mline" style="left:${(c.majority / c.total) * 100}%" title="Majority line: ${c.majority}"></span></div>
    <div class="row small muted"><span>${c.up} ${unit} on the ballot · ${c.uncalled} not reporting</span>${O || c.leading.O ? `<span class="pO">Other ${O} · ${c.leading.O} leading</span>` : ''}</div>
    ${tie}
    ${baseline.verified ? '' : `<div class="tiny" style="margin-top:4px"><span class="tag warn">Unverified baseline</span> Holdover counts are builder-compiled. <a href="#/admin">Correct in admin</a></div>`}
    <div class="legend" style="margin-top:6px"><span><i class="seg-D" style="background:var(--dem)"></i>Called/not up</span><span><i style="background:var(--dem-soft)"></i>Leading (striped)</span><span><i style="background:var(--none)"></i>Not reporting</span></div></div>`;
}

function calls(s) {
  if (!s.calls.length) return '<p class="empty">No races have been called by a named outlet yet.</p>';
  const retracted = (c) => (c.retracted ? ' <span class="tag warn">Withdrawn or corrected — no longer the current call</span>' : '');
  const byId = Object.fromEntries(s.races.map((r) => [r.id, r]));
  return `<ul class="feed">${s.calls.slice(0, 30).map((c) => {
    const r = byId[c.raceId];
    return `<li${c.retracted ? ' style="opacity:.6"' : ''}>${chip(c.party)} <a href="#/race/${encodeURIComponent(c.raceId)}"><b>${esc(r?.label || c.raceId)}</b></a>: ${esc(c.winner)} (${esc(PARTY_NAME[c.party] || 'Other')}) — called by <b>${esc(c.calledBy)}</b> at ${esc(timeET(c.calledAt))}${retracted(c)}<div class="src">via ${esc(c.via)}${c.source_url ? ` · <a href="${esc(c.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</div></li>`;
  }).join('')}</ul>`;
}

function control(s) {
  const row = (id, name) => {
    const v = s.control[id];
    if (!v || !v.n) return `<p><b>${name}:</b> <span class="muted">No control market found or feeds unreachable.</span></p>`;
    return `<div style="margin-bottom:10px"><b>${name}</b> ${oddsText(v.avg)}${oddsBar(v.avg)}<div>${v.sources.map((x) => src({ source: x.source, source_url: x.source_url, fetched_at: x.fetched_at, stale: x.stale, extra: x.low_volume ? ' <span class="tag warn">Low volume</span>' : '' })).join('<br>')}</div></div>`;
  };
  return `<header><h2>Chamber control — market-implied chance</h2><a class="small" href="#/odds">Odds →</a></header>${row('CONTROL-S', 'Senate')}${row('CONTROL-H', 'House')}`;
}

function strip(s) {
  const w = watched();
  const t1 = s.races.filter((r) => r.tier === 1 || w.has(r.id)).sort((a, b) => (w.has(b.id) - w.has(a.id)) || a.office.localeCompare(b.office) || a.label.localeCompare(b.label));
  if (!t1.length) return '<p class="empty">No Tier 1 races yet. Tiers come from forecaster ratings (enter them in Admin) and from market odds between 15% and 85% (needs a reachable market feed).</p>';
  return `<div class="strip">${t1.map((r) => `<a class="card" href="${raceLink(r)}">
    <div class="title"><span>${w.has(r.id) ? '<span aria-label="On your watchlist">★</span> ' : ''}${esc(r.label)}</span>${statusTag(r)}</div>
    <div class="small" style="margin:4px 0">${leadText(r)}</div>
    ${r.pctExpected != null ? `<div class="tiny muted">${r.pctExpected}% of expected vote counted</div>` : ''}
    <div class="small" style="margin-top:6px">${oddsText(r.odds)}</div>${oddsBar(r.odds)}
    <div class="tiny muted">${esc(r.resultSource ? `Results: ${r.resultSource}` : 'No results source yet')} · ${r.oddsSources.map((o) => esc(o.source) + (o.stale ? ' (stale)' : '')).join(', ') || 'no markets'}</div>
  </a>`).join('')}</div>`;
}

function closeTime(hhmm) {
  const next = hhmm.endsWith('+1');
  const [h, m] = hhmm.replace('+1', '').split(':');
  return new Date(`2026-11-0${next ? 4 : 3}T${h}:${m}:00-05:00`);
}
function nextClose(pc) {
  const now = Date.now();
  const groups = new Map();
  for (const [st, t] of Object.entries(pc.states || {})) {
    for (const [kind, v] of [['first', t.first], ['last', t.last]]) {
      const at = closeTime(v).getTime();
      if (!groups.has(at)) groups.set(at, { at, first: [], last: [] });
      groups.get(at)[kind].push(st);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => a.at - b.at);
  return { next: sorted.find((g) => g.at > now), all: sorted, at: sorted.find((g) => g.at > now)?.at };
}
function countdownText(at) {
  if (!at) return 'All polls closed';
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}h ` : ''}${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}
function polls(s) {
  const pc = s.pollClosing;
  const { next, all } = nextClose(pc);
  const now = Date.now();
  const fmt = (at) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const list = all.map((g) => {
    const lastOnly = g.last.filter((x) => !g.first.includes(x));
    return `<tr style="${g.at <= now ? 'opacity:.55' : ''}"><td class="num" style="white-space:nowrap">${fmt(g.at)} ET${g.at <= now ? ' ✓' : ''}</td><td>${g.first.length ? `<b>Polls close:</b> ${esc(g.first.join(', '))}` : ''}${lastOnly.length ? `${g.first.length ? '<br>' : ''}<b>Last polls close:</b> ${esc(lastOnly.join(', '))}` : ''}</td></tr>`;
  }).join('');
  return `<header><h2>Poll closings</h2>${pc.verified ? '' : '<span class="tag warn" title="Builder-compiled from state law; not checked against a live source">Unverified schedule</span>'}</header>
    ${next ? `<div class="small muted">Next closing at ${fmt(next.at)} ET: ${esc([...new Set([...next.first, ...next.last])].join(', '))}</div><div class="countdown num" data-k="countdown">${countdownText(next.at)}</div>` : '<div class="countdown">All polls closed</div>'}
    <details style="margin-top:6px"><summary>Full schedule</summary><div class="table-scroll"><table><tbody>${list}</tbody></table></div><p class="tiny muted">Times are Eastern. States with two times have polls in two time zones. Source: ${esc(pc.source)}${pc.source_url ? ` · <a href="${esc(pc.source_url)}" target="_blank" rel="noopener">check</a>` : ''}</p></details>`;
}
