// Turn prediction-market titles into race IDs, and outcome labels into parties.
// Matching is heuristic; anything it cannot place confidently is left
// unmatched and listed in the admin panel for manual mapping.
import { BY_POSTAL, stateFromName, SENATE_SPECIAL } from './states.js';
import { MEASURE_LABEL_RE, measureId } from '../measures.js';

export function raceId(office, state, district) {
  if (office === 'H') return `H-${state}-${String(district).padStart(2, '0')}`;
  return `${office}-${state}`;
}

const SENATE_RE = /\bsenate\b|\bsenator\b|\bsen\.\s/i;
const GOV_RE = /\bgovernor\b|\bgubernatorial\b|\bgov\.\s/i;
const HOUSE_RE = /\bhouse\b|\bcongressional\b|\bdistrict\b|\brepresentative\b/i;
const CONTROL_RE = /\b(control|majority|which party (will )?wins?|balance of power)\b/i;
const YEAR_OK_RE = /2026|midterm/i;
const BAD_YEAR_RE = /\b(2024|2028|2030|2032)\b/;
const PRIMARY_RE = /\bprimary\b|\bnominee\b|\bnomination\b|\brunoff\b/i;
// Offices that share words with the races we track but are different contests.
const OTHER_OFFICE_RE = /lieutenant|\blt\.?\s*gov|\bstate\s+(senate|house|legislature|assembly|representative)|\blegislat|\bgeneral assembly\b|\bhouse of delegates\b|\battorney general\b|\bsecretary of state\b|\bmayor\b|\bcity council\b/i;

// District code like "CA-13", "NY 17", "AK-AL".
const DISTRICT_CODE_RE = /\b([A-Z]{2})[- ]?(\d{1,2}|AL)\b/;
const DISTRICT_ORDINAL_RE = /\b(\d{1,2})(?:st|nd|rd|th)\s+(?:congressional\s+)?district\b/i;

/**
 * @returns {{raceId: string, confidence: 'ticker'|'title'} | null}
 */
export function matchMarket({ title = '', subtitle = '', ticker = '', seriesTicker = '' }) {
  const text = `${title} ${subtitle}`.trim();
  if (BAD_YEAR_RE.test(text) && !YEAR_OK_RE.test(text)) return null;
  if (PRIMARY_RE.test(text)) return null;
  if (OTHER_OFFICE_RE.test(text)) return null;

  // Kalshi tickers are the most reliable signal when present.
  const t = (seriesTicker || ticker || '').toUpperCase();
  let m;
  if ((m = t.match(/^CONTROL(S|H)\b/)) || /^(SENATE|HOUSE)CONTROL/.test(t)) {
    const chamber = m ? m[1] : t.startsWith('SENATE') ? 'S' : 'H';
    return { raceId: `CONTROL-${chamber}`, confidence: 'ticker' };
  }
  if ((m = t.match(/^SENATE([A-Z]{2})(S|SPECIAL)?$/)) && BY_POSTAL[m[1]]) {
    return { raceId: raceId('S', m[1]), confidence: 'ticker' };
  }
  if ((m = t.match(/^GOV(?:PARTY)?([A-Z]{2})$/)) && BY_POSTAL[m[1]]) {
    return { raceId: raceId('G', m[1]), confidence: 'ticker' };
  }
  if ((m = t.match(/^HOUSE([A-Z]{2})(\d{1,2}|AL)$/)) && BY_POSTAL[m[1]]) {
    return { raceId: raceId('H', m[1], m[2] === 'AL' ? 0 : Number(m[2])), confidence: 'ticker' };
  }

  const state = stateFromName(text);
  // Ballot measures: "Will California Proposition 50 pass?", "Florida Amendment 4".
  const ml = text.match(MEASURE_LABEL_RE);
  if (ml && state && /\b(pass|approve|yes|ballot|vote|measure|proposition|amendment|initiative|question|issue|referendum)\b/i.test(text)) {
    const id = measureId(state, ml[0]);
    if (id) return { raceId: id, confidence: 'title' };
  }
  const isSenate = SENATE_RE.test(text);
  const isGov = GOV_RE.test(text);
  const isHouse = HOUSE_RE.test(text);

  if (!state && CONTROL_RE.test(text)) {
    if (isSenate && !isHouse) return { raceId: 'CONTROL-S', confidence: 'title' };
    if (isHouse && !isSenate) return { raceId: 'CONTROL-H', confidence: 'title' };
    return null;
  }

  // District codes ("PA-07") identify House races even without a state name.
  const code = text.match(DISTRICT_CODE_RE);
  if (code && BY_POSTAL[code[1]] && (isHouse || /\b[A-Z]{2}-(\d{1,2}|AL)\b/.test(text))) {
    const d = code[2] === 'AL' ? 0 : Number(code[2]);
    if (validDistrict(code[1], d)) return { raceId: raceId('H', code[1], d), confidence: 'title' };
  }
  if (!state) return null;
  if (isHouse && !isSenate && !isGov) {
    const ord = text.match(DISTRICT_ORDINAL_RE);
    if (ord && validDistrict(state, Number(ord[1]))) return { raceId: raceId('H', state, Number(ord[1])), confidence: 'title' };
    // Single-seat states: accept "at-large" or wording that clearly means the U.S. House.
    if (BY_POSTAL[state].house === 1 && /at-large|u\.?\s?s\.?\s+house|\bcongress|house seat|house race|\brepresentative\b/i.test(text)) return { raceId: raceId('H', state, 0), confidence: 'title' };
    return null;
  }
  if (isSenate && !isGov) {
    // Ohio and Florida only have a special election on the 2026 Senate ballot.
    if (SENATE_SPECIAL.includes(state) || !/special/i.test(text)) return { raceId: raceId('S', state), confidence: 'title' };
    return null;
  }
  if (isGov && !isSenate) return { raceId: raceId('G', state), confidence: 'title' };
  return null;
}

function validDistrict(state, d) {
  const n = BY_POSTAL[state]?.house;
  if (!n) return false;
  if (n === 1) return d === 0 || d === 1;
  return d >= 1 && d <= n;
}

/** Map an outcome label ("Democratic Party", "Republican", "Jon Smith (R)") to a party code. */
export function partyFromLabel(label = '') {
  const l = ` ${label.toLowerCase()} `;
  if (/\bdemocrat(ic|s)?\b|\bdem(s)?\b|\(d\)|\bd\b(?!\.)/.test(l)) return 'D';
  if (/\brepublican(s)?\b|\bgop\b|\(r\)|\br\b(?!\.)/.test(l)) return 'R';
  if (/\bindependent\b|\(i\)|\blibertarian\b|\bgreen party\b|\bother\b|\bthird[- ]party\b/.test(l)) return 'O';
  return null;
}

// Normalize a candidate name for matching ("Sen. Jane Q. Doe Jr." -> "jane doe").
export function nameKey(name = '') {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(sen|rep|gov|dr|mr|mrs|ms|jr|sr|ii|iii|iv)\b\.?/g, ' ')
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 1)
    .filter((p, i, arr) => i === 0 || i === arr.length - 1)
    .join(' ');
}

export function lastName(name = '') {
  const parts = nameKey(name).split(' ');
  return parts[parts.length - 1] || '';
}
