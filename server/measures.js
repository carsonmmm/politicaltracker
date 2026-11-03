// Ballot measures. There is no free API listing them, so the catalog comes from
// data/measures-research.json (refreshed by research) and Admin entries, each with sources.
import path from 'node:path';
import { ROOT, readJson } from './lib/util.js';
import { BY_POSTAL } from './lib/states.js';

const isUrl = (u) => /^https?:\/\/\S+$/.test(u || '');
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

// "Proposition 50", "Prop. 1", "Amendment 4", "Question 2", "Issue 1", "Measure 114", "Initiative 2117"
export const MEASURE_LABEL_RE = /\b(proposition|prop\.?|amendment|measure|question|issue|initiative|referendum|constitutional amendment)\s*(?:no\.?|number|#)?\s*([0-9]{1,4}[a-z]?|[a-z])\b/i;

export function measureNumber(label = '') {
  const m = String(label).match(MEASURE_LABEL_RE);
  return m ? m[2].toUpperCase() : null;
}
export function measureId(state, label) {
  const n = measureNumber(label) || String(label).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return n && BY_POSTAL[state] ? `BM-${state}-${n}` : null;
}

export function validateMeasure(m) {
  const errs = [];
  if (!BY_POSTAL[m.state]) errs.push('state must be a two-letter postal code');
  if (!m.number || !measureId(m.state, m.number)) errs.push('number required, e.g. "Proposition 50"');
  if (!m.title) errs.push('title required');
  if (m.summary && !isUrl(m.summary_source_url)) errs.push('summary_source_url required with a summary');
  if (m.threshold && !/^(majority|\d{2}(\.\d)?%)$/.test(m.threshold)) errs.push('threshold is "majority" or a percent like "60%"');
  for (const side of ['supporters', 'opponents']) (m[side] || []).forEach((s, i) => { if (!s.name || !isUrl(s.source_url)) errs.push(`${side}[${i}]: name and source_url required`); });
  for (const side of ['support', 'oppose']) {
    const f = m.finance?.[side];
    if (f && (f.raised == null || !isUrl(f.source_url) || !isDate(f.as_of))) errs.push(`finance.${side}: raised, source_url and as_of (YYYY-MM-DD) required`);
  }
  return errs;
}

export function loadMeasures(file = process.env.MEASURES_FILE || path.join(ROOT, 'data', 'measures-research.json')) {
  const body = readJson(file, { entries: [] });
  const measures = [];
  const errors = [];
  for (const [i, m] of (body.entries || []).entries()) {
    const e = validateMeasure(m);
    if (e.length) errors.push(`entries[${i}] (${m.number || '?'}): ${e.join('; ')}`);
    else measures.push({ ...m, origin: 'research file' });
  }
  return { measures, errors };
}

/** Which side an outcome label is on: "Yes", "Will Prop 50 pass?" -> Y; "No", "fail" -> N. */
export function measureSide(label = '') {
  const l = ` ${label.toLowerCase()} `;
  if (/\bno\b|\bfail|\breject|\bnot pass|\bdefeat/.test(l)) return 'N';
  if (/\byes\b|\bpass|\bapprove|\badopt/.test(l)) return 'Y';
  return null;
}

/** Share Yes needs, as a fraction. */
export function thresholdShare(t) {
  if (!t || t === 'majority') return 0.5;
  return Number(t.replace('%', '')) / 100;
}
