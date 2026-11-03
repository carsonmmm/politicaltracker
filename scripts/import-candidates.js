// Import real candidates and the Senate baseline from public sources.
//   npm run import            (needs normal internet access; GitHub Actions workflow "Import data" runs it)
//
// Sources, each cited on every record it produces:
//   * Polymarket race markets: candidate names with party labels ("Jane Doe (D)"). A market
//     listing is not an official nominee list, so entries are marked listing_only and the
//     app labels them that way.
//   * Wikipedia (MediaWiki API): Senate and governor election infoboxes (nominee1/party1...)
//     as a cross-check. Agreement is recorded; disagreements go to the report.
//   * VoteView current-Congress members: which candidates are incumbents.
//   * senate.gov senator list (party + class): seats NOT on the 2026 ballot.
// Writes data/candidates-research.json (keeps any researched profiles), config/chamber.json
// (Senate part), and data/import-report.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPolymarketAdapter } from '../server/adapters/polymarket.js';
import { parseDelimited } from '../server/adapters/mit.js';
import { buildCatalog } from '../server/engine.js';
import { surnameMatches } from '../server/adapters/fec.js';
import { nameKey, partyFromLabel, lastName } from '../server/lib/match.js';
import { BY_POSTAL, SENATE_SPECIAL } from '../server/lib/states.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'midterm-live/0.1 (https://github.com/carsonmmm/politicaltracker; election tracker)';
const now = new Date().toISOString();
const today = now.slice(0, 10);
const report = [];
const log = (s) => { console.log(s); report.push(s); };

const PARTY_WORDS = /^(the\s+)?(democratic|democrat|republican|gop|independent|libertarian|green|other|another party|third party|any other)(\s+party)?(\s+candidate)?\s*(\([^)]*\))?$/i;
export const cleanName = (label) => String(label)
  .replace(/\s*\((?:D|R|I|L|G|Ind\.?|Dem\.?|Rep\.?|Independent|Democrat|Republican)\)\s*$/i, '')
  .replace(/^(sen|senator|rep|representative|gov|governor|dr|hon)\.?\s+/i, '')
  .replace(/\s+/g, ' ').trim();
const sameSurname = (a, b) => { const x = lastName(a), y = lastName(b); return Boolean(x && x === y); };

/** Pick candidates from one race's market outcomes. Returns {picked, skipped}. */
export function pickFromMarket(outcomes, { topN = 0, hints = [] } = {}) {
  const topTwo = topN > 0;
  // hints: [{name, party, source}] from other sources for this race (Wikipedia nominees, sitting members).
  const people = outcomes
    .filter((o) => o.price !== null && o.label && !PARTY_WORDS.test(String(o.label).trim()) && !/^(yes|no)$/i.test(o.label))
    .map((o) => {
      const name = cleanName(o.label);
      let party = o.party || partyFromLabel(o.label) || null;
      let hint = null;
      if (!party) {
        hint = hints.find((h) => h.party && sameSurname(h.name, name));
        if (hint) party = hint.party;
      }
      return { name, party, price: o.price, partySource: hint ? hint.source : null };
    })
    .filter((p, i, arr) => arr.findIndex((q) => nameKey(q.name) === nameKey(p.name)) === i)
    .sort((a, b) => b.price - a.price);
  const picked = [];
  const skipped = [];
  const add = (p, why) => { if (!picked.some((x) => nameKey(x.name) === nameKey(p.name))) picked.push({ ...p, why }); };
  if (topTwo) {
    // Top-two (CA, WA) / top-four (AK) states: the general-election candidates are the highest-priced names.
    for (const p of people.slice(0, topN)) (p.party ? add(p, 'top two in market') : skipped.push({ ...p, reason: 'no party label' }));
  } else {
    for (const party of ['D', 'R']) {
      const best = people.find((p) => p.party === party);
      if (best) add(best, `highest-priced ${party} in market`);
    }
  }
  // Others (independents, third parties) at 5%+ market odds, per the inclusion rule.
  for (const p of people) {
    if (p.price < 0.05 || picked.some((x) => nameKey(x.name) === nameKey(p.name)) || skipped.some((x) => nameKey(x.name) === nameKey(p.name))) continue;
    if (!p.party) skipped.push({ ...p, reason: 'no party label (5%+ in market)' });
    else if (p.party === 'O' || topTwo) add(p, '5%+ in market');
  }
  return { picked, skipped };
}

/** Pull nominee/party pairs out of a Wikipedia election infobox. */
export function parseInfobox(wikitext = '') {
  const strip = (v) => v
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  const fields = {};
  for (const line of wikitext.split('\n')) {
    const m = line.match(/^\s*\|\s*(nominee|candidate|party)(\d)\s*=\s*(.*)$/i);
    if (m) fields[`${m[1].toLowerCase()}${m[2]}`] = m[3];
  }
  const out = [];
  for (let i = 1; i <= 6; i++) {
    const raw = fields[`nominee${i}`] ?? fields[`candidate${i}`];
    if (!raw) continue;
    const name = strip(raw).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (!name || /^(tbd|tba|none)$/i.test(name)) continue;
    const ptxt = fields[`party${i}`] || '';
    const party = /democratic|\bdfl\b/i.test(ptxt) ? 'D' : /republican/i.test(ptxt) ? 'R' : ptxt ? 'O' : null;
    out.push({ name, party, party_label: strip(ptxt).replace(/\s*\(United States\)/, '') || null });
  }
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export function wikiTitle(race) {
  if (race.office === 'S') return SENATE_SPECIAL.includes(race.state) ? `2026 United States Senate special election in ${race.stateName}` : `2026 United States Senate election in ${race.stateName}`;
  if (race.office === 'G') return `2026 ${race.stateName} gubernatorial election`;
  return null;
}

async function wikipediaNominees(races) {
  const titles = races.map(wikiTitle).filter(Boolean);
  const byTitle = {};
  for (let i = 0; i < titles.length; i += 40) {
    const batch = titles.slice(i, i + 40);
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(batch.join('|'))}`;
    const body = await getJson(url);
    const redirect = Object.fromEntries((body.query?.redirects || []).map((r) => [r.to, r.from]));
    for (const p of body.query?.pages || []) {
      const text = p.revisions?.[0]?.slots?.main?.content;
      const asked = redirect[p.title] || p.title;
      byTitle[asked] = { nominees: text ? parseInfobox(text) : [], url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`, missing: Boolean(p.missing) };
    }
  }
  return byTitle;
}

/** Senators by party and class from senate.gov; seats not on the 2026 ballot. */
export function senateBaseline(xml) {
  const members = [...xml.matchAll(/<member>([\s\S]*?)<\/member>/g)].map((m) => {
    const tag = (t) => (m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1]?.trim() || '';
    return { last: tag('last_name'), first: tag('first_name'), party: tag('party'), state: tag('state'), cls: tag('class') };
  });
  const up = (s) => /II$/.test(s.cls) && !/III$/.test(s.cls) || (/III$/.test(s.cls) && SENATE_SPECIAL.includes(s.state));
  const notUp = members.filter((s) => !up(s));
  const count = (p) => notUp.filter((s) => s.party === p).length;
  return { members, notUp: { D: count('D'), R: count('R'), I: count('I') }, independents: notUp.filter((s) => s.party === 'I').map((s) => `${s.first} ${s.last} (${s.state})`), total: members.length };
}

async function main() {
  const races = buildCatalog();
  const byId = Object.fromEntries(races.map((r) => [r.id, r]));
  const formats = JSON.parse(fs.readFileSync(path.join(root, 'config/race-formats.json'), 'utf8')).states || {};
  log(`# Import report — ${now}\n`);

  // ---- 0. Other sources first, so they can supply parties for unlabelled market names ----
  let wiki = {};
  try {
    wiki = await wikipediaNominees(races.filter((r) => r.office === 'S' || r.office === 'G'));
  } catch (err) {
    log(`Wikipedia cross-check failed: ${err.message}`);
  }
  let current = [];
  try {
    current = parseDelimited(await getText('https://voteview.com/static/data/out/members/HSall_members.csv')).filter((m) => Number(m.congress) === 119);
  } catch (err) {
    log(`VoteView member list failed: ${err.message}`);
  }
  const VV_PARTY = { 100: 'D', 200: 'R' };
  const seatMembers = (r) => current.filter((m) => m.state_abbrev === r.state && (r.office === 'S' ? m.chamber === 'Senate' : r.office === 'H' ? m.chamber === 'House' : false));
  const hintsFor = (r) => [
    ...(wiki[wikiTitle(r)]?.nominees || []).map((n) => ({ name: n.name, party: n.party, source: 'Wikipedia' })),
    // Sitting members of Congress from the state, for party only: the same district, or another district
    // (redistricting moves members) only when that surname is unique in the state's delegation.
    ...seatMembers(r)
      .filter((m, _, all) => r.office !== 'H' || Number(m.district_code) === r.district || all.filter((x) => x.bioname.split(',')[0] === m.bioname.split(',')[0]).length === 1)
      .map((m) => ({ name: (m.bioname.split(',')[1] || '').trim().split(' ')[0] + ' ' + m.bioname.split(',')[0], party: VV_PARTY[m.party_code] || 'O', source: 'VoteView (119th Congress member list)' })),
  ];

  // ---- 1. Polymarket listings ----
  const poly = createPolymarketAdapter({});
  const { records } = await poly.refresh();
  const best = new Map();
  for (const r of records) {
    if (!byId[r.raceId]) continue;
    if (!/election winner|winner\??\s*$/i.test(r.title)) continue;
    if (!best.has(r.raceId) || (r.volume || 0) > (best.get(r.raceId).volume || 0)) best.set(r.raceId, r);
  }
  log(`Polymarket: ${best.size} races with a winner market.`);
  const cands = new Map(); // raceId -> [{name, party, sources:[...]}]
  const skipped = [];
  for (const [rid, rec] of best) {
    const race = byId[rid];
    const f = formats[race.state];
    const topN = race.state === 'AK' ? 4 : f?.topTwo && f.offices?.includes(race.office) ? 2 : 0;
    const { picked, skipped: sk } = pickFromMarket(rec.outcomes, { topN, hints: hintsFor(race) });
    cands.set(rid, picked.map((p) => ({ name: p.name, party: p.party, sources: [{ name: 'Polymarket market listing', url: rec.source_url, note: `${p.why}; ${Math.round(p.price * 100)}% at import${p.partySource ? `; party from ${p.partySource}` : ''}` }] })));
    for (const s of sk) skipped.push(`${rid}: "${s.name}" ${Math.round(s.price * 100)}% — ${s.reason}`);
  }

  // ---- 2. Wikipedia cross-check (Senate + governor) ----
  const disagreements = [];
  for (const r of races.filter((x) => x.office === 'S' || x.office === 'G')) {
    const w = wiki[wikiTitle(r)];
    if (!w || !w.nominees.length) continue;
    const list = cands.get(r.id) || [];
    for (const n of w.nominees) {
      const hit = list.find((c) => nameKey(c.name) === nameKey(n.name) || sameSurname(c.name, n.name));
      if (hit) {
        if (!hit.sources.some((s) => s.name === 'Wikipedia')) hit.sources.push({ name: 'Wikipedia', url: w.url });
        if (!hit.party && n.party) hit.party = n.party;
      } else if ((n.party === 'D' || n.party === 'R') && list.some((c) => c.party === n.party)) {
        // That party already has a candidate from the market: report, do not add a second one.
        disagreements.push(`${r.id}: Wikipedia's ${n.party} nominee is ${n.name}; the market's is ${list.find((c) => c.party === n.party).name} (kept the market's; check)`);
      } else if (n.party) {
        list.push({ name: n.name, party: n.party, sources: [{ name: 'Wikipedia', url: w.url, note: 'nominee in infobox; not in the market listing' }] });
        disagreements.push(`${r.id}: Wikipedia lists ${n.name} (${n.party}); the market does not`);
      }
    }
    cands.set(r.id, list);
  }

  // ---- 3. Incumbents from VoteView (current Congress) ----
  let incumbents = 0;
  try {
    const cur = current;
    for (const [rid, list] of cands) {
      const r = byId[rid];
      if (r.office === 'G') continue;
      for (const c of list) {
        const hit = cur.find((m) => m.state_abbrev === r.state && (r.office === 'S' ? m.chamber === 'Senate' : m.chamber === 'House' && (Number(m.district_code) === r.district || (r.district === 0 && Number(m.district_code) <= 1))) && surnameMatches(m.bioname, c.name));
        if (hit) { c.incumbent = true; c.bioguide_id = hit.bioguide_id || undefined; if (!c.sources.some((s) => s.name.startsWith('VoteView'))) c.sources.push({ name: 'VoteView (119th Congress member list)', url: `https://voteview.com/person/${hit.icpsr}` }); incumbents++; }
      }
    }
    log(`Incumbents marked from VoteView: ${incumbents}`);
  } catch (err) {
    log(`VoteView incumbent check failed: ${err.message}`);
  }

  // ---- 4. Write candidates-research.json (keep researched profiles) ----
  const file = path.join(root, 'data/candidates-research.json');
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kept = (existing.entries || []).filter((e) => !e.listing_only);
  const keptKeys = new Set(kept.map((e) => `${e.raceId}|${nameKey(e.name)}`));
  const entries = [...kept];
  let added = 0;
  for (const [rid, list] of [...cands].sort()) {
    for (const c of list) {
      if (!c.party) continue;
      if (keptKeys.has(`${rid}|${nameKey(c.name)}`)) continue;
      entries.push({ raceId: rid, name: c.name, party: c.party, incumbent: Boolean(c.incumbent), bioguide_id: c.bioguide_id, listing_only: true, researched_at: today, source: c.sources.map((s) => s.name).join(' + '), source_url: c.sources[0].url, sources: c.sources });
      added++;
    }
  }
  fs.writeFileSync(file, JSON.stringify({ ...existing, _note: existing._note, imported_at: now, entries }, null, 2) + '\n');
  const racesWith = new Set(entries.map((e) => e.raceId));
  log(`Candidates written: ${added} listing entries across ${racesWith.size} races (plus ${kept.length} researched profiles kept).`);
  const missing = races.filter((r) => !racesWith.has(r.id)).map((r) => r.id);
  log(`Races with no candidates found: ${missing.length}${missing.length ? ` — ${missing.slice(0, 60).join(', ')}${missing.length > 60 ? '…' : ''}` : ''}`);
  const oneParty = [...racesWith].filter((rid) => { const ps = new Set(entries.filter((e) => e.raceId === rid).map((e) => e.party)); return ps.size === 1; });
  log(`Races with candidates from only one party (check, may be uncontested): ${oneParty.length}${oneParty.length ? ` — ${oneParty.slice(0, 40).join(', ')}` : ''}`);

  // ---- 5. Senate baseline from senate.gov ----
  try {
    const xml = await getText('https://www.senate.gov/general/contact_information/senators_cfm.xml');
    const b = senateBaseline(xml);
    if (b.total < 90) throw new Error(`only ${b.total} senators parsed`);
    const chamberFile = path.join(root, 'config/chamber.json');
    const ch = JSON.parse(fs.readFileSync(chamberFile, 'utf8'));
    ch.senate.not_up = b.notUp;
    ch.senate.not_up_note = `Senators whose seats are not on the 2026 ballot, from senate.gov on ${today}: ${b.notUp.D} D, ${b.notUp.R} R, ${b.notUp.I} independent${b.independents.length ? ` (${b.independents.join(', ')})` : ''}. Independents are counted separately, not assigned to a party.`;
    ch.senate.source = `senate.gov senator list, ${today}`;
    ch.senate.source_url = 'https://www.senate.gov/general/contact_information/senators_cfm.xml';
    ch.senate_verified = true;
    ch._note = 'Senate seats not up come from senate.gov (party + class) via npm run import. House and governor baselines are still builder-compiled; verify them.';
    fs.writeFileSync(chamberFile, JSON.stringify(ch, null, 2) + '\n');
    log(`Senate baseline from senate.gov: ${b.total} senators; not up: D ${b.notUp.D}, R ${b.notUp.R}, I ${b.notUp.I}.`);
  } catch (err) {
    log(`senate.gov baseline failed (left unchanged): ${err.message}`);
  }

  log(`\n## Needs a human look\n`);
  log(`Names skipped because no source gave a party (${skipped.length}):`);
  for (const s of skipped.slice(0, 80)) log(`- ${s}`);
  log(`\nMarket vs. Wikipedia disagreements (${disagreements.length}):`);
  for (const d of disagreements) log(`- ${d}`);
  fs.writeFileSync(path.join(root, 'data/import-report.md'), report.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
