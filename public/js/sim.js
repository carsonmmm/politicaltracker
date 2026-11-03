// Simulator math. Pure functions (no DOM) so they can be unit-tested in Node.
//
// Model, shown on screen in plain words:
// * Each uncalled race's chance comes from the market average (Kalshi/Polymarket).
// * Races are linked by one shared national swing using a Gaussian copula:
//   latent z_i = sqrt(rho)*Z + sqrt(1-rho)*e_i, and D wins race i when z_i < Phi^-1(pD_i) + tilt.
//   With tilt = 0 each race still wins at exactly its market chance; rho only
//   controls how often races break the same way together.
// * Tilt is a user what-if that shifts every race toward one party. It is not a forecast.

export const PARTIES = ['D', 'R', 'O'];

/** Control rule for a chamber. Senate ties go to the tiebreak party. */
export function controlRule(conf) {
  const tb = conf.tiebreak?.party || null;
  return {
    majority: conf.majority,
    total: conf.total,
    tiebreak: tb,
    // Seats a party needs for control.
    need(party) {
      if (tb && conf.total % 2 === 0) return party === tb ? conf.total / 2 : conf.total / 2 + 1;
      return conf.majority;
    },
  };
}

/** Market chance for one race as {D, R, O} summing to 1, or null if no market. */
export function raceProbs(odds) {
  const D = odds?.D, R = odds?.R, O = odds?.O;
  if (D === undefined && R === undefined && O === undefined) return null;
  let d = D, r = R, o = O ?? 0;
  if (d === undefined && r !== undefined) d = Math.max(0, 1 - r - o);
  if (r === undefined && d !== undefined) r = Math.max(0, 1 - d - o);
  const tot = d + r + o;
  if (!(tot > 0)) return null;
  return { D: d / tot, R: r / tot, O: o / tot };
}

/**
 * Split a chamber's races into locked (called), assigned (scenario picks) and open.
 * scenario: {raceId: 'D'|'R'|'O'}
 */
export function tally(races, conf, scenario = {}) {
  const seats = { D: conf.not_up.D || 0, R: conf.not_up.R || 0, O: conf.not_up.I || 0 };
  const called = { D: 0, R: 0, O: 0 };
  const picked = { D: 0, R: 0, O: 0 };
  const open = [];
  const overridden = [];
  for (const r of races) {
    if (r.status === 'called' && r.call) {
      const p = PARTIES.includes(r.call.party) ? r.call.party : 'O';
      called[p]++;
      seats[p]++;
      if (scenario[r.id] && scenario[r.id] !== p) overridden.push(r.id);
    } else if (scenario[r.id]) {
      picked[scenario[r.id]]++;
      seats[scenario[r.id]]++;
    } else open.push(r);
  }
  return { seats, called, picked, open, overridden };
}

/**
 * Smallest set of open races party P needs for control: the k = need - seats
 * open races where markets give P the best chance. Any k races would do on
 * seat count alone; ranking by market chance shows the most plausible path.
 */
export function pathToMajority(t, rule, party) {
  const need = rule.need(party) - t.seats[party];
  if (need <= 0) return { party, need: 0, status: 'secured', races: [] };
  if (need > t.open.length) return { party, need, status: 'impossible', races: [] };
  const ranked = t.open
    .map((r) => ({ r, p: raceProbs(r.odds)?.[party] ?? null }))
    .sort((a, b) => (b.p ?? -1) - (a.p ?? -1) || a.r.label.localeCompare(b.r.label));
  const races = ranked.slice(0, need);
  const priced = races.every((x) => x.p !== null);
  // Joint chance of sweeping exactly this set if races were independent. Shown with that caveat.
  const jointIndep = priced ? races.reduce((a, x) => a * x.p, 1) : null;
  return { party, need, status: 'open', races, unpricedInPath: races.filter((x) => x.p === null).length, jointIndep };
}

// ---------- random numbers ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Inverse standard normal CDF (Acklam). */
export function invNorm(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628274631];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  let q, r;
  if (p < lo) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > hi) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Standard normal CDF. */
export function normCdf(x) {
  // Abramowitz–Stegun 7.1.26 via erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * Monte Carlo over the open races.
 * opts: { n, rho (0..1), tilt (std-normal units, + favours D), unpriced: 'undecided'|'coinflip', seed }
 * Returns control probabilities and the seat distribution for D and R.
 */
export function simulate(t, rule, { n = 10000, rho = 0.5, tilt = 0, unpriced = 'undecided', seed = 12345 } = {}) {
  const rand = mulberry32(seed);
  const priced = [];
  let unpricedCount = 0;
  for (const r of t.open) {
    const pr = raceProbs(r.odds);
    if (pr) priced.push({ id: r.id, thD: invNorm(pr.D), thR: invNorm(pr.D + pr.R) });
    else if (unpriced === 'coinflip') priced.push({ id: r.id, thD: 0, thR: Infinity, coin: true });
    else unpricedCount++;
  }
  const sr = Math.sqrt(Math.max(0, Math.min(1, rho)));
  const se = Math.sqrt(1 - sr * sr);
  const needD = rule.need('D'), needR = rule.need('R');
  const histD = new Map();
  let ctrlD = 0, ctrlR = 0, depends = 0, neither = 0;
  const raceWinsD = new Map(priced.map((p) => [p.id, 0]));
  for (let i = 0; i < n; i++) {
    const Z = gaussian(rand);
    let d = t.seats.D, r = t.seats.R;
    for (const p of priced) {
      // Latent z; subtracting tilt makes D wins more likely when tilt > 0.
      const z = sr * Z + se * gaussian(rand) - tilt;
      if (z < p.thD) { d++; raceWinsD.set(p.id, raceWinsD.get(p.id) + 1); }
      else if (z < p.thR) r++;
    }
    histD.set(d, (histD.get(d) || 0) + 1);
    // With undecided seats, control is only settled if it holds whichever way they go.
    const dSure = d >= needD, rSure = r >= needR;
    const dPossible = d + unpricedCount >= needD, rPossible = r + unpricedCount >= needR;
    if (dSure) ctrlD++;
    else if (rSure) ctrlR++;
    else if (dPossible || rPossible) depends++;
    else neither++;
  }
  const seatsD = [...histD.entries()].sort((a, b) => a[0] - b[0]);
  const q = (f) => {
    let acc = 0;
    for (const [s, c] of seatsD) { acc += c; if (acc / n >= f) return s; }
    return seatsD.at(-1)?.[0];
  };
  return {
    n, rho, tilt, unpriced, seed,
    pD: ctrlD / n, pR: ctrlR / n, pDepends: depends / n, pNeither: neither / n,
    unpricedCount, pricedCount: priced.filter((p) => !p.coin).length, coinflips: priced.filter((p) => p.coin).length,
    seatsD, medianD: q(0.5), lowD: q(0.1), highD: q(0.9),
    needD, needR,
    raceWinsD: Object.fromEntries([...raceWinsD].map(([k, v]) => [k, v / n])),
  };
}

// ---------- share links ----------
export function encodeScenario({ chamber, picks, rho, tilt, unpriced }) {
  const p = Object.entries(picks).map(([id, party]) => `${id}.${party}`).join(',');
  const q = new URLSearchParams({ c: chamber, rho: String(Math.round(rho * 100)), tilt: String(Math.round(tilt * 100)), u: unpriced === 'coinflip' ? '1' : '0' });
  if (p) q.set('a', p);
  return q.toString();
}
export function decodeScenario(qs) {
  const q = new URLSearchParams(qs);
  const picks = {};
  for (const pair of (q.get('a') || '').split(',')) {
    const m = pair.match(/^([A-Z]-[A-Z]{2}(?:-\d{2})?)\.(D|R|O)$/);
    if (m) picks[m[1]] = m[2];
  }
  const chamber = ['S', 'H', 'G'].includes(q.get('c')) ? q.get('c') : 'S';
  const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
  return {
    chamber,
    picks,
    rho: Math.max(0, Math.min(1, num('rho', 50) / 100)),
    tilt: Math.max(-1, Math.min(1, num('tilt', 0) / 100)),
    unpriced: q.get('u') === '1' ? 'coinflip' : 'undecided',
  };
}
