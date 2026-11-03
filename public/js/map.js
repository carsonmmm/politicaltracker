// Maps from pre-projected us-atlas topojson (Albers USA, 975x610).
/* global topojson */
import { esc, pct, PARTY_NAME, STATUS_LABEL } from './ui.js';

let statesTopo, countiesTopo;
async function loadStates() {
  statesTopo ||= await fetch('/geo/states.json').then((r) => r.json());
  return statesTopo;
}
async function loadCounties() {
  countiesTopo ||= await fetch('/geo/counties.json').then((r) => r.json());
  return countiesTopo;
}

function pathD(geom) {
  const rings = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return rings.map((poly) => poly.map((ring) => ring.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('') + 'Z').join('')).join('');
}
function centroid(geom) {
  // Centroid of the largest ring: good enough for labels.
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let best = null, bestA = -1;
  for (const poly of polys) {
    const ring = poly[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = [cx / (3 * a), cy / (3 * a)]; }
  }
  return best;
}

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const RATING_SCORE = { 'Solid D': -3, 'Safe D': -3, 'Likely D': -2, 'Lean D': -1, 'Tilt D': -0.5, 'Toss-up': 0, Tossup: 0, 'Tilt R': 0.5, 'Lean R': 1, 'Likely R': 2, 'Solid R': 3, 'Safe R': 3 };

/** Returns {fill, label, short} for a race summary under a colour mode. Text label always set (no colour-only meaning). */
export function colorFor(s, mode) {
  const none = { fill: css('--none'), label: 'No data', short: '' };
  if (!s) return { fill: css('--soft'), label: 'No race this year', short: '' };
  if (mode === 'scenario') {
    if (s.status === 'called' && s.call) return { fill: css(`--${s.call.party === 'D' ? 'dem' : s.call.party === 'R' ? 'rep' : 'oth'}`), label: `Called for ${PARTY_NAME[s.call.party] || 'Other'} by ${s.call.calledBy} (locked)`, short: `${s.call.party}✓` };
    if (s._pick) return { fill: css(`--${s._pick === 'D' ? 'dem-soft' : s._pick === 'R' ? 'rep-soft' : 'oth-soft'}`), label: `Your pick: ${PARTY_NAME[s._pick]} (click to change)`, short: `${s._pick}*` };
    return { ...none, label: 'Uncalled, no pick (click to assign)' };
  }
  if (mode === 'called') {
    if (s.status === 'called' && s.call) return { fill: css(`--${s.call.party === 'D' ? 'dem' : s.call.party === 'R' ? 'rep' : 'oth'}`), label: `${PARTY_NAME[s.call.party] || 'Other'} winner (called by ${s.call.calledBy})`, short: `${s.call.party}✓` };
    return { ...none, label: STATUS_LABEL[s.status] || 'Not called', short: '' };
  }
  if (mode === 'leader') {
    if (s.status === 'called' && s.call) return { fill: css(`--${s.call.party === 'D' ? 'dem' : s.call.party === 'R' ? 'rep' : 'oth'}`), label: `${PARTY_NAME[s.call.party]} winner (called by ${s.call.calledBy})`, short: `${s.call.party}✓` };
    if (s.leader) return { fill: css(`--${s.leader.party === 'D' ? 'dem-soft' : s.leader.party === 'R' ? 'rep-soft' : 'oth-soft'}`), label: `${PARTY_NAME[s.leader.party] || 'Other'} leading`, short: `${s.leader.party}+` };
    return { ...none, label: 'No votes reported' };
  }
  if (mode === 'odds') {
    const d = s.odds?.D, r = s.odds?.R;
    if (d === undefined && r === undefined) return { ...none, label: 'No market found' };
    const pd = d ?? 1 - r;
    // Diverging blend: D-blue at 1, R-red at 0, neutral grey at 0.5.
    const t = Math.min(1, Math.abs(pd - 0.5) * 2);
    const base = pd >= 0.5 ? css('--dem') : css('--rep');
    return { fill: mix(css('--none'), base, 0.25 + 0.75 * t), label: `Market-implied: D ${pct(d)}, R ${pct(r)}`, short: `${pd >= 0.5 ? 'D' : 'R'}${Math.round(Math.max(pd, 1 - pd) * 100)}` };
  }
  if (mode === 'rating') {
    if (!s.rating) return { ...none, label: 'No rating entered' };
    const sc = RATING_SCORE[s.rating.rating] ?? 0;
    const base = sc < 0 ? css('--dem') : sc > 0 ? css('--rep') : css('--oth');
    return { fill: sc === 0 ? css('--oth-soft') : mix(css('--none'), base, 0.3 + Math.abs(sc) * 0.23), label: `${s.rating.rating} (${s.rating.outlet}, ${s.rating.date})`, short: s.rating.rating.replace(/(Solid|Safe|Likely|Lean|Tilt) /, (m, a) => a[0]).replace('Toss-up', 'T') };
  }
  return none;
}

function mix(a, b, t) {
  const pa = hex(a), pb = hex(b);
  if (!pa || !pb) return b;
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
}
function hex(c) {
  const m = c.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

const FIPS_TO_POSTAL = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY' };

/** Render state map into el. byState: {postal: summary}. */
export async function renderStateMap(el, byState, mode, { onClick } = {}) {
  const topo = await loadStates();
  const feats = topojson.feature(topo, topo.objects.states).features;
  let paths = '', labels = '';
  for (const f of feats) {
    const postal = FIPS_TO_POSTAL[f.id];
    if (!postal || postal === 'DC') continue;
    const s = byState[postal];
    const c = colorFor(s, mode);
    const name = f.properties.name;
    const aria = `${name}: ${s ? `${s.label}. ${c.label}` : 'no race this year'}`;
    paths += `<path class="st" d="${pathD(f.geometry)}" fill="${c.fill}" data-state="${postal}" ${s ? `data-race="${esc(s.id)}" tabindex="0" role="link"` : ''} aria-label="${esc(aria)}"><title>${esc(aria)}</title></path>`;
    const ct = centroid(f.geometry);
    if (ct && !['RI', 'DE', 'CT', 'NJ', 'MD', 'MA', 'VT', 'NH', 'DC'].includes(postal)) labels += `<text x="${ct[0]}" y="${ct[1]}" text-anchor="middle">${postal}${c.short ? ` ${esc(c.short)}` : ''}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 975 610" role="group" aria-label="U.S. map">${paths}${labels}</svg>`;
  el.querySelectorAll('path[data-race]').forEach((p) => {
    const go = () => onClick?.(p.dataset.race);
    p.addEventListener('click', go);
    p.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go()));
  });
}

/** County map for one state. counties: [{fips, name, candidates:[{name, party, votes}]}] */
export async function renderCountyMap(el, stateFips, counties) {
  const topo = await loadCounties();
  const all = topojson.feature(topo, topo.objects.counties).features.filter((f) => f.id.startsWith(stateFips));
  if (!all.length) return (el.innerHTML = '<p class="empty">Not available — no county shapes for this state.</p>');
  const byFips = Object.fromEntries(counties.map((c) => [c.fips, c]));
  // Fit bounds.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of all) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  const paths = all.map((f) => {
    const c = byFips[f.id];
    let fill = css('--none'), label = `${f.properties.name}: no results reported`;
    if (c) {
      const tot = c.candidates.reduce((a, x) => a + x.votes, 0);
      const top = [...c.candidates].sort((a, b) => b.votes - a.votes)[0];
      if (tot > 0 && top) {
        const share = top.votes / tot;
        const base = css(top.party === 'D' ? '--dem' : top.party === 'R' ? '--rep' : '--oth');
        fill = mix(css('--none'), base, Math.min(1, 0.25 + (share - 0.4) * 2));
        label = `${f.properties.name}: ${top.name} leading with ${(share * 100).toFixed(1)}%${c.pctExpected != null ? `, ${c.pctExpected}% of expected vote` : ''}`;
      }
    }
    return `<path class="st" d="${pathD(f.geometry)}" fill="${fill}" aria-label="${esc(label)}" tabindex="0"><title>${esc(label)}</title></path>`;
  }).join('');
  el.innerHTML = `<svg viewBox="${x0 - 2} ${y0 - 2} ${x1 - x0 + 4} ${y1 - y0 + 4}" role="group" aria-label="County results map">${paths}</svg>`;
}
