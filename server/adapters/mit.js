// MIT Election Data + Science Lab past results, via the Harvard Dataverse API.
// Senate:    https://doi.org/10.7910/DVN/PEJ5QU   (U.S. Senate statewide, 1976-)
// House:     https://doi.org/10.7910/DVN/IG0UN2   (U.S. House, 1976-)
// President: https://doi.org/10.7910/DVN/42MVDX   (President by state, 1976-)
// Governor results are not published by MIT in these datasets.
import { fetchJson, nowIso, num } from '../lib/util.js';
import { raceId } from '../lib/match.js';
import { BY_POSTAL } from '../lib/states.js';

const BASE = process.env.DATAVERSE_BASE || 'https://dataverse.harvard.edu';
export const DATASETS = {
  senate: process.env.MIT_SENATE_DOI || 'doi:10.7910/DVN/PEJ5QU',
  house: process.env.MIT_HOUSE_DOI || 'doi:10.7910/DVN/IG0UN2',
  president: process.env.MIT_PRESIDENT_DOI || 'doi:10.7910/DVN/42MVDX',
};
export const SOURCE = 'MIT Election Data and Science Lab';

/** Minimal CSV/TSV parser (handles quoted fields with commas, quotes and newlines). */
export function parseDelimited(text) {
  const firstLine = text.slice(0, text.indexOf('\n'));
  const d = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const partyOf = (r) => {
  const p = `${r.party_simplified || ''} ${r.party || ''} ${r.party_detailed || ''}`.toUpperCase();
  if (/DEMOCRAT|\bDFL\b/.test(p)) return 'D';
  if (/REPUBLICAN/.test(p)) return 'R';
  return 'O';
};
const truthy = (v) => /^(true|t|1|yes)$/i.test(String(v || '').trim());
// MIT writes some names "LAST, FIRST M. JR" (president file) and others "FIRST LAST". Show "First M. Last Jr".
export function titleName(s = '') {
  let n = String(s).trim();
  const m = n.match(/^([^,]+),\s*([^,]+)$/);
  if (m) {
    const given = m[2].trim();
    const suf = given.match(/\s+(JR|SR|II|III|IV)\.?$/i);
    n = `${suf ? given.slice(0, suf.index) : given} ${m[1].trim()}${suf ? ` ${suf[1]}` : ''}`;
  }
  return n.toLowerCase().replace(/(^|[\s\-'(])([a-z])/g, (x, a, b) => a + b.toUpperCase()).replace(/\b(Ii|Iii|Iv)\b/g, (x) => x.toUpperCase()).replace(/\s+/g, ' ').trim();
}

/** Collapse rows (one per candidate per voting mode / fusion line) into elections. */
export function aggregate(rows, keyFn) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.stage && !/^gen/i.test(r.stage)) continue;
    if (truthy(r.runoff)) continue;
    if (truthy(r.writein) && !r.candidate) continue;
    const k = keyFn(r);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, { year: Number(r.year), special: truthy(r.special), totalvotes: num(r.totalvotes), cands: new Map(), unofficial: truthy(r.unofficial) });
    const e = byKey.get(k);
    const name = titleName(r.candidate || 'Other / write-in');
    const c = e.cands.get(name) || { name, party: partyOf(r), votes: 0 };
    c.votes += num(r.candidatevotes) || 0;
    if (c.party === 'O') c.party = partyOf(r);
    e.cands.set(name, c);
  }
  const out = new Map();
  for (const [k, e] of byKey) out.set(k, { year: e.year, special: e.special, totalvotes: e.totalvotes, unofficial: e.unofficial, candidates: [...e.cands.values()].sort((a, b) => b.votes - a.votes) });
  return out;
}

/** Turn the three datasets into { raceId: [elections newest first] } plus president by state. */
export function buildPast({ senate = [], house = [], president = [] }) {
  const races = {};
  const push = (rid, e) => (races[rid] ||= []).push(e);

  // Senate: keep elections for the same seat. Regular 2026 seats are Class II
  // (elected 2020, 2014, 2008...). OH and FL specials fill Class III seats (2022, 2016...).
  const sen = aggregate(senate, (r) => (r.state_po && r.year ? `${r.state_po}|${r.year}|${truthy(r.special) ? 's' : 'r'}` : null));
  for (const [k, e] of sen) {
    const [st] = k.split('|');
    if (!BY_POSTAL[st]) continue;
    const special2026 = st === 'OH' || st === 'FL';
    const cycle = special2026 ? 2028 : 2026;
    if ((cycle - e.year) % 6 === 0 && !e.special) push(raceId('S', st), e);
  }
  const hs = aggregate(house, (r) => (r.state_po && r.year ? `${r.state_po}|${Number(r.district) || 0}|${r.year}|${truthy(r.special) ? 's' : 'r'}` : null));
  for (const [k, e] of hs) {
    const [st, dist] = k.split('|');
    if (!BY_POSTAL[st] || e.special) continue;
    const d = BY_POSTAL[st].house === 1 ? 0 : Number(dist);
    push(raceId('H', st, d), e);
  }
  for (const rid of Object.keys(races)) races[rid] = races[rid].sort((a, b) => b.year - a.year).slice(0, rid.startsWith('S-') ? 3 : 4);

  const pres = {};
  const pr = aggregate(president, (r) => (r.state_po && r.year ? `${r.state_po}|${r.year}` : null));
  for (const [k, e] of pr) {
    const [st] = k.split('|');
    (pres[st] ||= []).push(e);
  }
  for (const st of Object.keys(pres)) pres[st] = pres[st].sort((a, b) => b.year - a.year).slice(0, 3);
  return { races, president: pres };
}

export function createMitAdapter({ fetchImpl } = {}) {
  async function fileFor(doi, want) {
    const meta = await fetchJson(`${BASE}/api/datasets/:persistentId/?persistentId=${encodeURIComponent(doi)}`, { fetchImpl, timeoutMs: 30000 });
    const files = (meta.data?.latestVersion?.files || []).map((f) => f.dataFile || f).filter((f) => f && f.id);
    const scored = files
      .map((f) => ({ f, name: `${f.originalFileName || ''} ${f.filename || ''}`.toLowerCase() }))
      .filter((x) => /\.(csv|tab)\b/.test(x.name) && want.test(x.name) && !/source|codebook|readme/.test(x.name))
      .sort((a, b) => (b.f.filesize || 0) - (a.f.filesize || 0));
    if (!scored.length) throw new Error(`no data file found in ${doi}`);
    return scored[0].f;
  }
  async function download(doi, want) {
    const f = await fileFor(doi, want);
    const url = `${BASE}/api/access/datafile/${f.id}?format=original`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
      const res = await (fetchImpl || fetch)(url, { signal: ctrl.signal, headers: { 'User-Agent': 'midterm-live/0.1' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${f.originalFileName || f.filename}`);
      return { rows: parseDelimited(await res.text()), file: f.originalFileName || f.filename, url: `https://doi.org/${doi.replace(/^doi:/, '')}` };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    source: SOURCE,
    async fetchAll() {
      const [senate, house, president] = await Promise.all([
        download(DATASETS.senate, /senate/),
        download(DATASETS.house, /house/),
        download(DATASETS.president, /president/),
      ]);
      const built = buildPast({ senate: senate.rows, house: house.rows, president: president.rows });
      return {
        ...built,
        fetched_at: nowIso(),
        files: { senate: { file: senate.file, url: senate.url }, house: { file: house.file, url: house.url }, president: { file: president.file, url: president.url } },
      };
    },
  };
}
