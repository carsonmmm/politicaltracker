import { esc, pct, chip, oddsText, statusTag, leadText, raceLink, patch, PARTY_NAME } from '../ui.js';
import { renderStateMap } from '../map.js';
import { controlRule, tally, pathToMajority, simulate, raceProbs, normCdf, encodeScenario, decodeScenario } from '../sim.js';

const CHAMBER = { S: { name: 'Senate', key: 'senate', unit: 'seats', control: 'CONTROL-S' }, H: { name: 'House', key: 'house', unit: 'seats', control: 'CONTROL-H' }, G: { name: 'Governors', key: 'governors', unit: 'governorships', control: null } };
const SAVE_KEY = 'savedScenarios';
let sc = null; // {chamber, picks, rho, tilt, unpriced}
let filter = '';
let simTimer = null;

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '[]'); } catch { return []; }
}
function storeSaved(list) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(list)); } catch {}
}

export async function mount(root, ctx) {
  lastMapKey = ''; // new DOM: always draw the map once
  let last = '';
  try { last = sessionStorage.getItem('lastScenario') || ''; } catch {}
  sc = decodeScenario(ctx.params.query || last);
  root.innerHTML = `<div id="sim-root"><h1>Simulator</h1>
    <p class="small muted">Pick winners in uncalled races to see who controls each chamber, then run thousands of simulated outcomes from current market odds. This is a what-if tool built on market prices. It is not a forecast by this site.</p>
    <div class="toggles"><div class="seg" role="group" aria-label="Chamber">${Object.entries(CHAMBER).map(([k, v]) => `<button type="button" data-ch="${k}">${v.name}</button>`).join('')}</div></div>
    <div class="grid g2">
      <section class="panel" aria-label="Your scenario">
        <div data-k="tally"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button class="btn ghost" type="button" id="reset">Reset picks</button>
          <button class="btn ghost" type="button" id="share">Copy share link</button>
          <button class="btn ghost" type="button" id="save">Save scenario</button>
        </div>
        <div class="msg" id="sc-msg" aria-live="polite"></div>
        <div data-k="saved"></div>
      </section>
      <section class="panel" aria-label="Monte Carlo simulation">
        <header><h2>Monte Carlo simulation</h2><span class="small muted">10,000 runs</span></header>
        <label>Shared national swing: <span id="rho-v"></span>
          <input type="range" id="rho" min="0" max="100" step="5" aria-describedby="rho-help"></label>
        <p class="tiny muted" id="rho-help">How strongly races move together. 0% = every race is independent. Higher = when one party beats its odds in one state, it tends to beat them everywhere. Each race still wins at its market chance on average.</p>
        <label>What-if tilt: <span id="tilt-v"></span>
          <input type="range" id="tilt" min="-50" max="50" step="5" aria-describedby="tilt-help"></label>
        <p class="tiny muted" id="tilt-help">Shifts every uncalled race toward one party by the same amount. At 0 the simulation uses market odds as they are. Any other setting is your assumption, not the markets'.</p>
        <label>Races with no market <select id="unpriced"><option value="undecided">Leave undecided (control shown as "depends")</option><option value="coinflip">Treat as 50/50 (assumption)</option></select></label>
        <div data-k="mc" style="margin-top:10px"></div>
      </section>
    </div>
    <section class="panel" style="margin-top:16px" aria-label="Path to majority"><div data-k="path"></div></section>
    <div class="grid g2" style="margin-top:16px">
      <section class="panel" aria-label="Scenario map" data-k="mapwrap-head"></section>
      <section class="panel" aria-label="Uncalled races">
        <header><h2>Uncalled races</h2><input type="search" id="flt" placeholder="Filter (state, district…)" aria-label="Filter races" style="max-width:220px"></header>
        <div data-k="list"></div>
      </section>
    </div></div>`;
  const wrap = root.querySelector('#sim-root');
  root.querySelector('[data-k="mapwrap-head"]').innerHTML = '<header><h2>Map</h2><span class="small muted">Click a state to cycle: no pick → D → R</span></header><div class="map-wrap" id="sim-map"></div><div class="legend" style="margin-top:6px"><span><i style="background:var(--dem)"></i>Called D (locked)</span><span><i style="background:var(--dem-soft)"></i>Your D pick (*)</span><span><i style="background:var(--rep-soft)"></i>Your R pick (*)</span><span><i style="background:var(--rep)"></i>Called R (locked)</span><span><i style="background:var(--none)"></i>No pick</span></div>';
  root.querySelector('[data-k="mapwrap-head"]').removeAttribute('data-k');

  root.querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', () => { sc.chamber = b.dataset.ch; changed(root, ctx); }));
  const rho = root.querySelector('#rho'), tilt = root.querySelector('#tilt'), unp = root.querySelector('#unpriced');
  rho.value = Math.round(sc.rho * 100);
  tilt.value = Math.round(sc.tilt * 100);
  unp.value = sc.unpriced;
  rho.addEventListener('input', () => { sc.rho = rho.value / 100; changed(root, ctx); });
  tilt.addEventListener('input', () => { sc.tilt = tilt.value / 100; changed(root, ctx); });
  unp.addEventListener('change', () => { sc.unpriced = unp.value; changed(root, ctx); });
  root.querySelector('#flt').addEventListener('input', (e) => { filter = e.target.value.toLowerCase(); renderList(root, ctx); });
  root.querySelector('#reset').addEventListener('click', () => {
    for (const r of chamberRaces(ctx)) delete sc.picks[r.id];
    changed(root, ctx);
    msg(root, 'Picks for this chamber cleared.');
  });
  root.querySelector('#share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#/sim?${encodeScenario(sc)}`;
    try { await navigator.clipboard.writeText(url); msg(root, 'Link copied. Anyone who opens it sees your picks applied to the live data at that moment.'); }
    catch { msg(root, `Copy this link: ${url}`); }
  });
  root.querySelector('#save').addEventListener('click', () => {
    const name = prompt('Name this scenario', `${CHAMBER[sc.chamber].name} scenario ${new Date().toLocaleTimeString()}`);
    if (!name) return;
    const list = loadSaved().filter((s) => s.name !== name);
    list.unshift({ name, q: encodeScenario(sc), saved_at: new Date().toISOString() });
    storeSaved(list.slice(0, 30));
    renderSaved(root, ctx);
    msg(root, 'Saved in this browser.');
  });
  // Delegated clicks for pick buttons (list) and saved-scenario actions.
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (b) {
      const [id, party] = b.dataset.pick.split('|');
      if (party === '-' || sc.picks[id] === party) delete sc.picks[id];
      else sc.picks[id] = party;
      changed(root, ctx);
      return;
    }
    const l = e.target.closest('[data-load]');
    if (l) { sc = decodeScenario(l.dataset.load); syncControls(root); changed(root, ctx); msg(root, 'Scenario loaded.'); }
    const d = e.target.closest('[data-del]');
    if (d) { storeSaved(loadSaved().filter((s) => s.name !== d.dataset.del)); renderSaved(root, ctx); }
  });
  changed(root, ctx);
  renderSaved(root, ctx);
}

export function update(root, ctx) {
  // New data (calls, odds): recompute everything; picks on newly called races are ignored and flagged.
  changed(root, ctx, { keepUrl: true });
}

function syncControls(root) {
  root.querySelector('#rho').value = Math.round(sc.rho * 100);
  root.querySelector('#tilt').value = Math.round(sc.tilt * 100);
  root.querySelector('#unpriced').value = sc.unpriced;
}

function msg(root, text) {
  root.querySelector('#sc-msg').textContent = text;
}

const chamberRaces = (ctx) => ctx.state.races.filter((r) => r.office === sc.chamber);
const conf = (ctx) => ctx.state.balance[CHAMBER[sc.chamber].key];

function changed(root, ctx, { keepUrl = false } = {}) {
  root.querySelectorAll('[data-ch]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ch === sc.chamber)));
  root.querySelector('#rho-v').textContent = `${Math.round(sc.rho * 100)}%`;
  const shift = Math.round((normCdf(sc.tilt) - 0.5) * 100);
  root.querySelector('#tilt-v').textContent = sc.tilt === 0 ? 'none (market odds as-is)' : `toward ${sc.tilt > 0 ? 'Democrats' : 'Republicans'}, a 50/50 race becomes ${50 + Math.abs(shift)}/${50 - Math.abs(shift)}`;
  if (!keepUrl) {
    const q = encodeScenario(sc);
    history.replaceState(null, '', `#/sim?${q}`);
    try { sessionStorage.setItem('lastScenario', q); } catch {}
  }
  const races = chamberRaces(ctx);
  const c = conf(ctx);
  const rule = controlRule(c);
  const t = tally(races, c, sc.picks);
  patch(root, { tally: renderTally(t, rule, c), path: renderPath(t, rule) });
  renderList(root, ctx, t);
  drawMap(root, ctx, races);
  clearTimeout(simTimer);
  patch(root, { mc: '<p class="small muted">Running…</p>' });
  simTimer = setTimeout(() => {
    const res = simulate(t, rule, { rho: sc.rho, tilt: sc.tilt, unpriced: sc.unpriced });
    patch(root, { mc: renderMc(res, rule, ctx) });
  }, 120);
}

function renderTally(t, rule, c) {
  const name = CHAMBER[sc.chamber].name;
  const needD = rule.need('D'), needR = rule.need('R');
  const undecided = t.open.length;
  const segs = [
    ['D', c.not_up.D + t.called.D, 'seg-D'], ['Dp', t.picked.D, 'seg-Dl'], ['O', (c.not_up.I || 0) + t.called.O + t.picked.O, 'seg-O'],
    ['U', undecided, 'seg-U'], ['Rp', t.picked.R, 'seg-Rl'], ['R', c.not_up.R + t.called.R, 'seg-R'],
  ];
  let verdict;
  if (t.seats.D >= needD) verdict = `<b class="pD">Democrats control</b> the ${name} in this scenario.`;
  else if (t.seats.R >= needR) verdict = `<b class="pR">Republicans control</b> the ${name} in this scenario.`;
  else verdict = `No party has control yet: ${undecided} ${CHAMBER[sc.chamber].unit} still open.`;
  return `<header><h2>Your scenario: ${name}</h2><span class="small muted">${sc.chamber === 'S' && rule.tiebreak ? `D needs ${needD}, R needs ${needR} (VP tiebreak)` : `${rule.majority} for majority`}</span></header>
    <div class="bop"><div class="row"><span class="pD"><b>D ${t.seats.D}</b> (${c.not_up.D} not up · ${t.called.D} called · ${t.picked.D} your picks)</span><span class="pR"><b>R ${t.seats.R}</b> (${c.not_up.R} not up · ${t.called.R} called · ${t.picked.R} your picks)</span></div>
    <div class="bar" role="img" aria-label="${esc(`Democrats ${t.seats.D}, Republicans ${t.seats.R}, ${undecided} open`)}">${segs.filter(([, n]) => n > 0).map(([, n, cls]) => `<span class="${cls}" style="width:${(n / c.total) * 100}%"></span>`).join('')}<span class="mline" style="left:${(rule.majority / c.total) * 100}%"></span></div>
    <div class="small">${verdict}${t.seats.O ? ` Others: ${t.seats.O}.` : ''}</div></div>
    ${t.overridden.length ? `<div class="callout warn">${t.overridden.length} of your picks conflict with a race that has since been called; the call wins: ${t.overridden.map(esc).join(', ')}.</div>` : ''}
    ${sc.chamber === 'G' ? '<p class="tiny muted">Governors do not form a chamber; "control" here means holding a majority of the 50 governorships.</p>' : ''}`;
}

function renderPath(t, rule) {
  const col = (party) => {
    const p = pathToMajority(t, rule, party);
    const head = `<h3>${chip(party)} ${PARTY_NAME[party]}s</h3>`;
    if (p.status === 'secured') return `${head}<p class="small">Already at or above ${rule.need(party)} in this scenario.</p>`;
    if (p.status === 'impossible') return `${head}<p class="small">Cannot reach ${rule.need(party)}: needs ${p.need} more but only ${t.open.length} open.</p>`;
    return `${head}<p class="small">Needs <b>${p.need}</b> of the ${t.open.length} open ${CHAMBER[sc.chamber].unit}. The ${p.need} where markets give ${party} the best chance:</p>
      <ol class="small" style="padding-left:20px;max-height:260px;overflow:auto">${p.races.map((x) => `<li><a href="${raceLink(x.r)}">${esc(x.r.label)}</a> — ${x.p === null ? '<span class="muted">no market</span>' : `market-implied ${pct(x.p)}`} <button type="button" class="btn ghost" style="padding:0 6px;font-size:.75rem" data-pick="${esc(x.r.id)}|${party}" aria-label="Pick ${party} in ${esc(x.r.label)}">pick</button></li>`).join('')}</ol>
      ${p.jointIndep !== null ? `<p class="tiny muted">Chance of winning all of these if races were independent: ${p.jointIndep < 0.001 ? '<0.1%' : pct(p.jointIndep, 1)}. Races are linked in practice, so see the simulation for a better picture.</p>` : `<p class="tiny muted">${p.unpricedInPath} race(s) in this path have no market.</p>`}`;
  };
  return `<header><h2>Path to majority</h2><span class="small muted">Smallest number of open races each party needs, ranked by market-implied chance</span></header><div class="grid g2">${['D', 'R'].map((p) => `<div>${col(p)}</div>`).join('')}</div>`;
}

function renderMc(res, rule, ctx) {
  const name = CHAMBER[sc.chamber].name;
  const ctl = CHAMBER[sc.chamber].control ? ctx.state.control[CHAMBER[sc.chamber].control] : null;
  const rows = [
    ['D', `Democrats reach ${res.needD}`, res.pD],
    ['R', `Republicans reach ${res.needR}`, res.pR],
  ];
  if (res.unpricedCount) rows.push(['U', `Depends on the ${res.unpricedCount} races with no market`, res.pDepends]);
  if (res.pNeither) rows.push(['O', 'Neither party reaches control (others hold the balance)', res.pNeither]);
  const maxC = Math.max(...res.seatsD.map(([, c]) => c), 1);
  const lo = res.seatsD[0]?.[0] ?? 0, hi = res.seatsD.at(-1)?.[0] ?? 0;
  const w = 600, h = 110, bw = w / Math.max(1, hi - lo + 1);
  const bars = res.seatsD.map(([s, c]) => `<rect x="${(s - lo) * bw}" y="${h - (c / maxC) * (h - 14)}" width="${Math.max(1, bw - 1)}" height="${(c / maxC) * (h - 14)}" fill="${s >= res.needD ? 'var(--dem)' : 'var(--rep)'}"><title>${s} D ${CHAMBER[sc.chamber].unit}: ${pct(c / res.n, 1)} of runs</title></rect>`).join('');
  const nx = (res.needD - lo) * bw;
  return `<table><tbody>${rows.map(([p, l, v]) => `<tr><td>${p === 'U' || p === 'O' ? '' : chip(p)} ${esc(l)}</td><td class="r num"><b>${pct(v, 1)}</b></td></tr>`).join('')}</tbody></table>
    <p class="small">Democratic ${CHAMBER[sc.chamber].unit}: median <b>${res.medianD}</b>, 80% of runs between <b>${res.lowD}</b> and <b>${res.highD}</b>${res.unpricedCount ? ` (before the ${res.unpricedCount} undecided)` : ''}.</p>
    <div class="chart"><svg viewBox="0 0 ${w} ${h + 14}" role="img" aria-label="${esc(`Distribution of Democratic ${CHAMBER[sc.chamber].unit} across ${res.n} runs`)}">${bars}${nx >= 0 && nx <= w ? `<line x1="${nx}" x2="${nx}" y1="0" y2="${h}" stroke="var(--ink)" stroke-dasharray="3 2"/><text x="${nx + 3}" y="10">${res.needD} = D control</text>` : ''}<text x="0" y="${h + 12}">${lo}</text><text x="${w}" y="${h + 12}" text-anchor="end">${hi}</text></svg>
    <div class="legend"><span><i style="background:var(--dem)"></i>Runs with D control</span><span><i style="background:var(--rep)"></i>Runs without</span></div></div>
    <p class="tiny muted">${res.pricedCount} open races use market odds${res.coinflips ? `, ${res.coinflips} treated as 50/50 by your choice` : ''}${res.unpricedCount ? `, ${res.unpricedCount} left undecided` : ''}. Called races and your picks are fixed. Third-party winners count for neither party.</p>
    ${ctl?.n ? `<p class="small">For comparison, the ${name} control market itself: ${oddsText(ctl.avg)} <span class="tiny muted">(market-implied, ${ctl.sources.map((s) => esc(s.source)).join(' + ')})</span></p>` : ''}
    <details class="small" style="margin-top:6px"><summary>How the simulation works</summary>
      <p>Each run draws one shared national swing, then a separate local surprise for every open race. A race goes to the Democrat when the combined draw falls below the market's chance for that race. So with the swing set to 0%, races are independent coin flips weighted by their odds. At higher settings, a good night for one party in one state usually means a good night elsewhere too, because real election results move together. Either way, each race still wins at its own market odds on average. The tilt slider moves every race the same way, as a what-if you choose. Statistically this is a Gaussian copula: the "swing" setting is the share of each race's variance that is shared.</p>
      <p>Market odds already reflect votes counted so far. Inputs are refreshed whenever the live data updates.</p>
    </details>`;
}

function renderList(root, ctx, t) {
  const races = chamberRaces(ctx);
  t ||= tally(races, conf(ctx), sc.picks);
  const open = races.filter((r) => !(r.status === 'called' && r.call));
  const shown = open
    .filter((r) => !filter || `${r.label} ${r.stateName} ${r.id}`.toLowerCase().includes(filter))
    .sort((a, b) => closeness(a) - closeness(b) || a.label.localeCompare(b.label, 'en', { numeric: true }));
  const called = races.filter((r) => r.status === 'called' && r.call);
  patch(root, {
    list: `<p class="small muted">${open.length} uncalled · ${Object.keys(sc.picks).filter((id) => open.some((r) => r.id === id)).length} picked. Closest markets first.</p>
      <div class="table-scroll" style="max-height:520px;overflow:auto"><table><tbody>${shown.slice(0, 450).map((r) => {
        const pick = sc.picks[r.id];
        return `<tr><td><a href="${raceLink(r)}"><b>${esc(r.label)}</b></a><div class="tiny">${oddsText(r.odds)}${r.leader ? ` · ${esc(r.leader.name)} leading` : ''}</div></td>
          <td style="white-space:nowrap"><div class="seg" role="group" aria-label="Pick winner for ${esc(r.label)}">${['D', 'R', 'O'].map((p) => `<button type="button" data-pick="${esc(r.id)}|${p}" aria-pressed="${pick === p}">${p === 'O' ? 'Oth' : p}</button>`).join('')}<button type="button" data-pick="${esc(r.id)}|-" aria-pressed="${!pick}" aria-label="No pick">—</button></div></td></tr>`;
      }).join('')}</tbody></table></div>
      ${called.length ? `<details style="margin-top:8px"><summary>Called races (${called.length}, locked)</summary><ul class="feed">${called.map((r) => `<li>${chip(r.call.party)} ${esc(r.label)}: ${esc(r.call.winner)} — ${esc(r.call.calledBy)}</li>`).join('')}</ul></details>` : ''}`,
  });
}

function closeness(r) {
  const p = raceProbs(r.odds);
  return p ? Math.abs(p.D - 0.5) : 1;
}

let lastMapKey = '';
async function drawMap(root, ctx, races) {
  const el = root.querySelector('#sim-map');
  if (sc.chamber === 'H') {
    el.innerHTML = '<p class="empty">The House has no state map; use the list to pick districts.</p>';
    lastMapKey = 'H';
    return;
  }
  const byState = Object.fromEntries(races.map((r) => [r.state, { ...r, _pick: sc.picks[r.id] || null }]));
  const key = JSON.stringify([sc.chamber, races.map((r) => [r.id, r.status, r.call?.party, sc.picks[r.id] || ''])]);
  if (key === lastMapKey) return;
  lastMapKey = key;
  await renderStateMap(el, byState, 'scenario', {
    onClick: (id) => {
      const r = races.find((x) => x.id === id);
      if (!r || (r.status === 'called' && r.call)) return;
      const cur = sc.picks[id];
      if (!cur) sc.picks[id] = 'D';
      else if (cur === 'D') sc.picks[id] = 'R';
      else delete sc.picks[id];
      changed(root, ctx);
    },
  });
}

function renderSaved(root) {
  const list = loadSaved();
  patch(root, {
    saved: list.length
      ? `<details style="margin-top:8px"><summary>Saved scenarios (${list.length})</summary><ul class="feed">${list.map((s) => `<li><b>${esc(s.name)}</b> <span class="tiny muted">${esc(new Date(s.saved_at).toLocaleString())}</span><br><button type="button" class="btn ghost" style="padding:2px 8px" data-load="${esc(s.q)}">Load</button> <button type="button" class="btn ghost" style="padding:2px 8px" data-del="${esc(s.name)}">Delete</button></li>`).join('')}</ul></details>`
      : '',
  }, true);
}
