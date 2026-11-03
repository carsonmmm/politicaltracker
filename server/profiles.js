// Candidate profiles: one fixed template for every candidate (neutrality rule).
// Content comes from data/candidates-research.json (refreshed by research) and
// Admin edits; every fact carries a source_url.
import path from 'node:path';
import { ROOT, readJson } from './lib/util.js';
import { nameKey } from './lib/match.js';

export const ISSUES = [
  ['economy', 'Economy and taxes'],
  ['health', 'Health care'],
  ['immigration', 'Immigration'],
  ['abortion', 'Abortion'],
  ['energy', 'Energy and climate'],
  ['guns', 'Guns'],
  ['education', 'Education'],
  ['foreign', 'Foreign policy and defense'],
  ['crime', 'Crime and policing'],
  ['democracy', 'Elections and democracy'],
];
export const ISSUE_KEYS = ISSUES.map(([k]) => k);
export const MOMENT_TYPES = ['debate', 'ad', 'endorsement', 'controversy', 'event', 'other'];

export const candidateSlug = (name) => nameKey(name).replace(/\s+/g, '-');
export const candidateKey = (raceId, name) => `${raceId}:${candidateSlug(name)}`;

const isUrl = (u) => /^https?:\/\/\S+$/.test(u || '');
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

/** Returns a list of problems (empty = valid). Used for the research file and Admin. */
export function validateProfile(p) {
  const errs = [];
  if (!p.raceId || !p.name) errs.push('raceId and name required');
  const needUrl = (obj, where) => obj && !isUrl(obj.source_url) && errs.push(`${where}: source_url required`);
  if (p.bio) {
    if (Object.values(p.bio).some((v) => v !== null && v !== '' && v !== undefined) && !isUrl(p.bio.source_url)) errs.push('bio: source_url required');
    if (p.bio.birth_date && !isDate(p.bio.birth_date)) errs.push('bio.birth_date must be YYYY-MM-DD');
  }
  for (const [k, v] of Object.entries(p.positions || {})) {
    if (!ISSUE_KEYS.includes(k)) errs.push(`positions: unknown issue "${k}"`);
    else if (v?.none) { if (!isDate(v.checked_at)) errs.push(`positions.${k}: "none found" needs checked_at date`); }
    else if (v) { if (!v.summary) errs.push(`positions.${k}: summary required`); needUrl(v, `positions.${k}`); }
  }
  (p.endorsements || []).forEach((e, i) => { if (!e.name) errs.push(`endorsements[${i}]: name required`); needUrl(e, `endorsements[${i}]`); });
  (p.offices || []).forEach((o, i) => { if (!o.title) errs.push(`offices[${i}]: title required`); needUrl(o, `offices[${i}]`); });
  (p.elections || []).forEach((o, i) => { if (!o.year || !o.office) errs.push(`elections[${i}]: year and office required`); needUrl(o, `elections[${i}]`); });
  (p.roles || []).forEach((o, i) => { if (!o.title) errs.push(`roles[${i}]: title required`); needUrl(o, `roles[${i}]`); });
  return errs;
}

export function validateMoment(m) {
  const errs = [];
  if (!m.raceId) errs.push('raceId required');
  if (!isDate(m.date)) errs.push('date must be YYYY-MM-DD');
  if (!MOMENT_TYPES.includes(m.type)) errs.push(`type must be one of ${MOMENT_TYPES.join(', ')}`);
  if (!m.text) errs.push('text required');
  if (!isUrl(m.source_url)) errs.push('source_url required (every moment, including criticism, needs a link)');
  return errs;
}

export function loadResearch(file = process.env.CANDIDATES_FILE || path.join(ROOT, 'data', 'candidates-research.json')) {
  const body = readJson(file, { entries: [], moments: [] });
  const profiles = [];
  const moments = [];
  const errors = [];
  for (const [i, p] of (body.entries || []).entries()) {
    const e = validateProfile(p);
    if (e.length) errors.push(`entries[${i}] (${p.name || '?'}): ${e.join('; ')}`);
    else profiles.push({ ...p, origin: 'research file' });
  }
  for (const [i, m] of (body.moments || []).entries()) {
    const e = validateMoment(m);
    if (e.length) errors.push(`moments[${i}]: ${e.join('; ')}`);
    else moments.push({ ...m, origin: 'research file' });
  }
  return { profiles, moments, errors };
}

/** Age in whole years on a given date, derived from a sourced birth date. */
export function ageOn(birth, on = new Date()) {
  if (!isDate(birth)) return null;
  const b = new Date(`${birth}T00:00:00Z`);
  let a = on.getUTCFullYear() - b.getUTCFullYear();
  const m = on.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

/** Merge research + manual into the full template, so every candidate has the same fields. */
export function buildProfile(base, research, manual) {
  const r = research || {};
  const m = manual || {};
  const pick = (k) => (m[k] !== undefined ? m[k] : r[k]);
  const positions = {};
  for (const [k, label] of ISSUES) {
    const v = m.positions?.[k] ?? r.positions?.[k] ?? null;
    positions[k] = { label, ...(v ? (v.none ? { status: 'none', checked_at: v.checked_at, searched: v.searched || null } : { status: 'stated', summary: v.summary, source_url: v.source_url, date: v.date || null }) : { status: 'unresearched' }) };
  }
  const bio = { ...(r.bio || {}), ...(m.bio || {}) };
  return {
    ...base,
    fec_id: m.fec_id || r.fec_id || base.fec_id || null,
    bioguide_id: m.bioguide_id || r.bioguide_id || null,
    bio: { ...bio, age: bio.birth_date ? ageOn(bio.birth_date) : bio.age ?? null },
    offices: pick('offices') || [],
    elections: pick('elections') || [],
    roles: pick('roles') || [],
    endorsements: pick('endorsements') || [],
    positions,
    // A candidate-list entry (listing_only) is not a researched profile.
    researched: Boolean((research && !research.listing_only) || manual),
    origins: [research && 'research file', manual && 'Manual'].filter(Boolean),
    updated_at: m.entered_at || r.researched_at || null,
  };
}
