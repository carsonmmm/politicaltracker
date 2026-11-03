// Live smoke test: runs the real adapters against the real APIs and prints a summary.
// Meant for CI or any machine with normal internet access:  npm run smoke
// It only reads public data and writes nothing to the app's data folder.
import { createKalshiAdapter } from '../server/adapters/kalshi.js';
import { createPolymarketAdapter } from '../server/adapters/polymarket.js';
import { createFecAdapter } from '../server/adapters/fec.js';
import { createHouseClerkAdapter, createSenateEfdAdapter } from '../server/adapters/disclosures.js';
import { createCongressAdapter } from '../server/adapters/voteview.js';

const line = (s = '') => console.log(s);
const section = (t) => line(`\n=== ${t} ===`);
const t0 = Date.now();

async function rawCheck(name, url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'midterm-live/0.1 (election tracker)', Accept: 'application/json', ...headers } });
    const body = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
    line(`${name}: HTTP ${res.status}${res.ok ? '' : ` body: ${body}`}`);
    return res.status;
  } catch (err) {
    line(`${name}: ${err.cause?.code || err.message}`);
    return 0;
  }
}

async function step(name, fn) {
  section(name);
  try {
    await fn();
  } catch (err) {
    line(`FAILED: ${err.message}`);
  }
}

await step('Kalshi (raw request diagnostics)', async () => {
  const u = 'https://api.elections.kalshi.com/trade-api/v2/events?limit=1&status=open';
  await rawCheck('plain GET', u);
  await rawCheck('GET with Origin header (what the old probe sent)', u, { Origin: 'http://localhost' });
  await rawCheck('GET /series?category=Elections', 'https://api.elections.kalshi.com/trade-api/v2/series?category=Elections');
});

await step('Kalshi adapter: discovery + refresh', async () => {
  const k = createKalshiAdapter({});
  const d = await k.discover();
  line(`discovery method: ${d.method}; matched events: ${d.matched}; unmatched election-looking: ${d.unmatched}`);
  const byRace = new Map();
  for (const [ticker, v] of k.getKnown()) byRace.set(v.raceId, [...(byRace.get(v.raceId) || []), `${ticker} "${v.title}"`]);
  line(`distinct races matched: ${byRace.size}`);
  for (const [rid, list] of [...byRace].sort().slice(0, 60)) line(`  ${rid.padEnd(10)} <- ${list.slice(0, 2).join(' | ')}`);
  line('unmatched sample:');
  for (const u of k.getUnmatched().slice(0, 40)) line(`  ? ${u.key} "${u.title}"`);
  const { records, errors } = await k.refresh();
  line(`refresh: ${records.length} records, ${errors.length} errors${errors[0] ? ` (first: ${errors[0]})` : ''}`);
  for (const r of records.slice(0, 15)) line(`  ${r.raceId.padEnd(10)} ${r.outcomes.map((o) => `${o.party || '?'}:${o.label}=${o.price}`).join('  ')}  vol=${r.volume}`);
  const noParty = records.filter((r) => r.outcomes.some((o) => !o.party)).length;
  line(`records with an outcome that has no party: ${noParty}`);
});

await step('Polymarket adapter', async () => {
  const p = createPolymarketAdapter({});
  const { records } = await p.refresh();
  const races = new Set(records.map((r) => r.raceId));
  line(`matched events: ${records.length}; distinct races: ${races.size}`);
  for (const r of records.slice(0, 40)) line(`  ${r.raceId.padEnd(10)} "${r.title}" ${r.outcomes.slice(0, 4).map((o) => `${o.party || '?'}:${o.label}=${o.price}`).join('  ')}`);
  line('unmatched sample:');
  for (const u of p.getUnmatched().slice(0, 40)) line(`  ? ${u.key} "${u.title}"`);
});

await step('OpenFEC (DEMO_KEY unless FEC_API_KEY is set)', async () => {
  const fec = createFecAdapter({ perHour: 1e6 });
  const rows = await fec.raceSummary({ office: 'S', state: 'GA' });
  line(`GA Senate filers: ${rows.length}`);
  for (const r of rows.slice(0, 6)) line(`  ${r.fec_id} ${r.name} (${r.party}) raised ${r.receipts} cash ${r.cash_on_hand} through ${r.coverage_end_date}`);
});

await step('Congress.gov member record', async () => {
  const m = await createCongressAdapter({}).member('O000174');
  line(`O000174: ${m.name}; terms: ${m.terms.length}; sponsored: ${m.sponsored}`);
});

await step('House Clerk disclosure index (2025)', async () => {
  const d = await createHouseClerkAdapter({}).fetchYears([2025]);
  const ptr = d.filings.filter((f) => f.type === 'P').length;
  line(`filings: ${d.filings.length}; stock-trade reports (PTR): ${ptr}`);
  line(`sample: ${JSON.stringify(d.filings[0])}`);
});

await step('Senate eFD search (terms agreement + search)', async () => {
  const r = await createSenateEfdAdapter({}).search('Ossoff', { withTrades: 1 });
  line(`reports: ${r.reports.length}`);
  for (const x of r.reports.slice(0, 4)) line(`  ${x.first} ${x.last} | ${x.title} | ${x.filed} | trades parsed: ${x.trades ? x.trades.length : 'n/a'}`);
});

await step('VoteView members file (size check only)', async () => {
  const res = await fetch('https://voteview.com/static/data/out/members/HSall_members.csv', { method: 'HEAD' });
  line(`HTTP ${res.status}; content-length ${res.headers.get('content-length')}`);
});

await step('Harvard Dataverse dataset listing (MIT Senate)', async () => {
  const res = await fetch('https://dataverse.harvard.edu/api/datasets/:persistentId/?persistentId=doi:10.7910/DVN/PEJ5QU');
  const j = await res.json();
  const files = (j.data?.latestVersion?.files || []).map((f) => `${f.dataFile?.id}:${f.dataFile?.originalFileName || f.dataFile?.filename}`);
  line(`HTTP ${res.status}; files: ${files.join(', ')}`);
});

line(`\nDone in ${Math.round((Date.now() - t0) / 1000)} s`);
