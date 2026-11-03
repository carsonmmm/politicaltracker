// TEST ONLY. A fake Kalshi / Polymarket / AP server with obviously fake data,
// used to exercise the full pipeline when the real APIs are unreachable.
// Run: node test/mock-upstream.js  then start the app with
//   KALSHI_BASE=http://localhost:9090/kalshi POLYMARKET_BASE=http://localhost:9090/poly \
//   POLYMARKET_CLOB=http://localhost:9090/clob AP_BASE=http://localhost:9090/ap AP_API_KEY=fake npm start
import http from 'node:http';
import zlib from 'node:zlib';

// ---- tiny ZIP writer (deflate) for the fake House Clerk index ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function makeZip(name, content) {
  const data = Buffer.from(content);
  const comp = zlib.deflateRawSync(data);
  const nm = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nm.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + nm.length + comp.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nm, comp, central, nm, end]);
}

const SENATE_CSV = `year,state,state_po,office,district,stage,special,candidate,party_detailed,writein,mode,candidatevotes,totalvotes,unofficial,version,party_simplified
2020,GEORGIA,GA,US SENATE,statewide,gen,FALSE,"CANDIDATE-B, TEST (FIXTURE)",REPUBLICAN,FALSE,TOTAL,2400000,4950000,FALSE,1,REPUBLICAN
2020,GEORGIA,GA,US SENATE,statewide,gen,FALSE,"CANDIDATE-A, TEST",DEMOCRAT,FALSE,TOTAL,2370000,4950000,FALSE,1,DEMOCRAT
2014,GEORGIA,GA,US SENATE,statewide,gen,FALSE,OLDER FIXTURE R,REPUBLICAN,FALSE,TOTAL,1350000,2560000,FALSE,1,REPUBLICAN
2014,GEORGIA,GA,US SENATE,statewide,gen,FALSE,OLDER FIXTURE D,DEMOCRAT,FALSE,TOTAL,1160000,2560000,FALSE,1,DEMOCRAT
2018,GEORGIA,GA,US SENATE,statewide,gen,FALSE,WRONG SEAT FIXTURE,REPUBLICAN,FALSE,TOTAL,1,1,FALSE,1,REPUBLICAN
`;
const HOUSE_CSV = `year,state,state_po,office,district,stage,runoff,special,candidate,party,writein,mode,candidatevotes,totalvotes,unofficial,version,fusion_ticket
2024,ALASKA,AK,US HOUSE,0,GEN,FALSE,FALSE,AT-LARGE FIXTURE R,REPUBLICAN,FALSE,TOTAL,160000,330000,FALSE,1,FALSE
2024,ALASKA,AK,US HOUSE,0,GEN,FALSE,FALSE,AT-LARGE FIXTURE D,DEMOCRAT,FALSE,TOTAL,150000,330000,FALSE,1,FALSE
`;
const PRES_CSV = `year,state,state_po,office,candidate,party_detailed,writein,candidatevotes,totalvotes,version,notes,party_simplified
2024,GEORGIA,GA,US PRESIDENT,"PRESIDENT-R, FIXTURE",REPUBLICAN,FALSE,2660000,5250000,1,,REPUBLICAN
2024,GEORGIA,GA,US PRESIDENT,"PRESIDENT-D, FIXTURE",DEMOCRAT,FALSE,2550000,5250000,1,,DEMOCRAT
`;
const VV_MEMBERS = `congress,chamber,icpsr,state_icpsr,district_code,state_abbrev,party_code,occupancy,last_means,bioname,bioguide_id,born,died,nominate_dim1,nominate_dim2
119,Senate,99901,44,0,GA,100,,,"CANDIDATE-A, Test",T000001,1980,,-0.351,0.102
118,Senate,99901,44,0,GA,100,,,"CANDIDATE-A, Test",T000001,1980,,-0.348,0.100
119,Senate,99902,44,0,TX,200,,,"FIXTURE, Senator One",F000001,1960,,0.62,0.2
119,Senate,99903,44,0,NY,100,,,"FIXTURE, Senator Two",F000002,1960,,-0.5,0.1
119,House,99904,44,1,AK,200,,,"CANDIDATE-E, Test",T000005,1970,,0.41,0.05
`;
const VV_S_VOTES = `congress,chamber,rollnumber,icpsr,cast_code,prob
119,Senate,1,99901,1,99
119,Senate,2,99901,6,90
119,Senate,3,99901,9,
119,Senate,1,99902,6,99
`;
const VV_S_ROLLS = `congress,chamber,rollnumber,date,session,clerk_rollnumber,yea_count,nay_count,bill_number,vote_result,vote_desc,vote_question,dtl_desc
119,Senate,1,2025-01-20,1,1,52,48,S5,Passed,Test bill (FIXTURE),On Passage,
119,Senate,2,2025-02-01,1,2,49,51,S6,Rejected,Other test bill (FIXTURE),On Passage,
`;
const CLERK_XML = `<?xml version="1.0" encoding="utf-8"?><FinancialDisclosure>
<Member><Prefix>Hon.</Prefix><Last>Candidate-E</Last><First>Test</First><Suffix></Suffix><FilingType>P</FilingType><StateDst>AK00</StateDst><Year>2026</Year><FilingDate>3/14/2026</FilingDate><DocID>20099001</DocID></Member>
<Member><Prefix>Hon.</Prefix><Last>Candidate-E</Last><First>Test</First><Suffix></Suffix><FilingType>O</FilingType><StateDst>AK00</StateDst><Year>2026</Year><FilingDate>5/15/2026</FilingDate><DocID>10099002</DocID></Member>
<Member><Prefix></Prefix><Last>Candidate-A</Last><First>Test</First><Suffix></Suffix><FilingType>C</FilingType><StateDst>GA00</StateDst><Year>2026</Year><FilingDate>6/1/2026</FilingDate><DocID>10099003</DocID></Member>
</FinancialDisclosure>`;

const PORT = Number(process.env.MOCK_PORT || 9090);
let tick = 0;
const wobble = (base) => Math.max(0.02, Math.min(0.98, base + Math.sin(tick / 3) * 0.03));

export const kalshiEvents = () => [
  { event_ticker: 'SENATEZZ-26', series_ticker: 'SENATEGA', title: 'Georgia Senate winner? (TEST FIXTURE)', category: 'Elections' },
  { event_ticker: 'CONTROLS-2026', series_ticker: 'CONTROLS', title: 'Which party will control the Senate? (TEST FIXTURE)', category: 'Elections' },
  { event_ticker: 'GOVPA-26', series_ticker: 'GOVPA', title: 'Pennsylvania Governor winner? (TEST FIXTURE)', category: 'Elections' },
  ...[['NC', 0.58], ['ME', 0.47], ['MI', 0.62], ['OH', 0.33], ['IA', 0.27], ['TX', 0.18], ['NH', 0.7], ['AK', 0.22]].map(([st, p]) => ({ event_ticker: `SENATE${st}-26`, series_ticker: `SENATE${st}`, title: `${st} Senate winner? (TEST FIXTURE)`, category: 'Elections', _p: p })),
  { event_ticker: 'SPORTS-1', series_ticker: 'NFL', title: 'Who wins the game?', category: 'Sports' },
  { event_ticker: 'WEIRD-26', series_ticker: 'WEIRD', title: 'Will the 2026 Senate race in Atlantis be close?', category: 'Elections' },
];
const kalshiMarkets = (ticker) => {
  const fixed = kalshiEvents().find((e) => e.event_ticker === ticker)?._p;
  const p = fixed ?? (ticker === 'GOVPA-26' ? 0.71 : ticker === 'CONTROLS-2026' ? 0.38 : wobble(0.52));
  return [
    { ticker: `${ticker}-D`, yes_sub_title: 'Democratic party', yes_bid: Math.round(p * 100) - 1, yes_ask: Math.round(p * 100) + 1, last_price: Math.round(p * 100), volume: 1200000, status: 'active' },
    { ticker: `${ticker}-R`, yes_sub_title: 'Republican party', yes_bid: Math.round((1 - p) * 100) - 1, yes_ask: Math.round((1 - p) * 100) + 1, last_price: Math.round((1 - p) * 100), volume: 900000, status: 'active' },
  ];
};

const polyEvents = () => [
  {
    slug: 'ca-prop-99-test', title: 'Will California Proposition 99 pass? (TEST FIXTURE)', volume: 800000,
    markets: [{ id: 'm9', question: 'Will California Proposition 99 pass?', outcomes: '["Yes","No"]', outcomePrices: '["0.61","0.39"]', volumeNum: 800000 }],
  },
  {
    slug: 'georgia-senate-2026-test', title: 'Georgia Senate Election Winner 2026 (TEST FIXTURE)', volume: 3400000,
    markets: [
      { id: 'm1', question: 'Will the Democrats win GA?', groupItemTitle: 'Democratic', outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(wobble(0.55)), String(1 - wobble(0.55))]), volumeNum: 2000000, clobTokenIds: '["tokD","tokDn"]' },
      { id: 'm2', question: 'Will the Republicans win GA?', groupItemTitle: 'Republican', outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(1 - wobble(0.55)), String(wobble(0.55))]), volumeNum: 1400000, clobTokenIds: '["tokR","tokRn"]' },
    ],
  },
  {
    slug: 'house-control-2026-test', title: 'Which party will win the House in 2026? (TEST FIXTURE)', volume: 9000,
    markets: [{ id: 'm3', question: 'House control', outcomes: '["Democratic","Republican"]', outcomePrices: '["0.64","0.36"]', volumeNum: 9000 }],
  },
];

const apBody = () => ({
  timestamp: new Date().toISOString(),
  races: [
    {
      raceID: '1', officeID: 'S', statePostal: 'GA', raceCallStatus: 'Too Close to Call',
      reportingUnits: [
        { level: 'state', statePostal: 'GA', eevp: 40 + tick, lastUpdated: new Date().toISOString(), candidates: [
          { first: 'Test', last: 'Candidate-A', party: 'Dem', voteCount: 410000 + tick * 1000, incumbent: true },
          { first: 'Test', last: 'Candidate-B', party: 'GOP', voteCount: 405000 + tick * 900 },
        ] },
        { level: 'FIPSCode', fipsCode: '13121', reportingunitName: 'Fulton', eevp: 50, candidates: [
          { first: 'Test', last: 'Candidate-A', party: 'Dem', voteCount: 150000 }, { first: 'Test', last: 'Candidate-B', party: 'GOP', voteCount: 60000 } ] },
        { level: 'FIPSCode', fipsCode: '13015', reportingunitName: 'Bartow', eevp: 70, candidates: [
          { first: 'Test', last: 'Candidate-A', party: 'Dem', voteCount: 9000 }, { first: 'Test', last: 'Candidate-B', party: 'GOP', voteCount: 30000 } ] },
      ],
    },
    {
      raceID: '2', officeID: 'G', statePostal: 'PA',
      reportingUnits: [{ level: 'state', statePostal: 'PA', eevp: 88, candidates: [
        { first: 'Test', last: 'Candidate-C', party: 'Dem', voteCount: 2900000, winner: 'X', incumbent: true },
        { first: 'Test', last: 'Candidate-D', party: 'GOP', voteCount: 2300000 },
      ] }],
    },
    {
      raceID: '9', officeID: 'I', statePostal: 'CA', seatName: 'Proposition 99',
      reportingUnits: [{ level: 'state', statePostal: 'CA', eevp: 30, candidates: [{ first: 'Yes', last: '', party: 'NP', voteCount: 3100000 }, { first: 'No', last: '', party: 'NP', voteCount: 2700000 }] }],
    },
    {
      raceID: '3', officeID: 'H', statePostal: 'AK', seatNum: '1',
      reportingUnits: [{ level: 'state', statePostal: 'AK', eevp: 10, candidates: [
        { first: 'Test', last: 'Candidate-E', party: 'GOP', voteCount: 20000 }, { first: 'Test', last: 'Candidate-F', party: 'Dem', voteCount: 19000 } ] }],
    },
  ],
});

export function createMock() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname === '/kalshi/series') {
      if (process.env.MOCK_NO_SERIES) { res.writeHead(404); return res.end('{}'); }
      const cat = u.searchParams.get('category');
      const all = [...new Set(kalshiEvents().map((e) => e.series_ticker))].map((t) => ({ ticker: t, title: t, category: t === 'NFL' ? 'Sports' : 'Elections' }));
      return json({ series: all.filter((x) => x.category === cat) });
    }
    if (u.pathname === '/kalshi/events') {
      const st = u.searchParams.get('series_ticker');
      return json({ events: kalshiEvents().filter((e) => !st || e.series_ticker === st), cursor: '' });
    }
    let m;
    if ((m = u.pathname.match(/^\/kalshi\/events\/(.+)$/))) {
      const ev = kalshiEvents().find((e) => e.event_ticker === decodeURIComponent(m[1]));
      return json({ event: ev, markets: kalshiMarkets(ev.event_ticker) });
    }
    if (u.pathname.includes('/candlesticks')) {
      const now = Math.floor(Date.now() / 1000);
      return json({ candlesticks: Array.from({ length: 48 }, (_, i) => ({ end_period_ts: now - (48 - i) * 3600 * 6, price: { close: 40 + Math.round(Math.sin(i / 5) * 8) } })) });
    }
    if (u.pathname === '/poly/events') return json(u.searchParams.get('offset') === '0' && u.searchParams.get('tag_slug') === 'midterms' ? polyEvents() : []);
    if (u.pathname === '/clob/prices-history') {
      const now = Math.floor(Date.now() / 1000);
      return json({ history: Array.from({ length: 60 }, (_, i) => ({ t: now - (60 - i) * 3600 * 4, p: 0.5 + Math.sin(i / 7) * 0.08 })) });
    }
    if (u.pathname.startsWith('/ap/elections')) return json(apBody());
    // ---- fake OpenFEC ----
    if (u.pathname === '/fec/elections/') {
      if (u.searchParams.get('state') !== 'GA' || u.searchParams.get('office') !== 'senate') return json({ results: [] });
      return json({ results: [
        { candidate_id: 'S6GA00001', candidate_name: 'CANDIDATE-A, TEST', party_full: 'DEMOCRATIC PARTY', incumbent_challenge_full: 'Incumbent', candidate_pcc_id: 'C00000001', total_receipts: 52000000, total_disbursements: 41000000, cash_on_hand_end_period: 11000000, coverage_end_date: '2026-10-14T00:00:00' },
        { candidate_id: 'S6GA00002', candidate_name: 'CANDIDATE-B, TEST', party_full: 'REPUBLICAN PARTY', incumbent_challenge_full: 'Challenger', candidate_pcc_id: 'C00000002', total_receipts: 23000000, total_disbursements: 20000000, cash_on_hand_end_period: 3000000, coverage_end_date: '2026-10-14T00:00:00' },
        { candidate_id: 'S6GA00003', candidate_name: 'PRIMARYLOSER, TEST', party_full: 'REPUBLICAN PARTY', total_receipts: 4000000, total_disbursements: 4000000, cash_on_hand_end_period: 0 },
      ] });
    }
    if ((m = u.pathname.match(/^\/fec\/candidate\/(\w+)\/totals\/$/))) {
      const a = m[1] === 'S6GA00001';
      return json({ results: [{ receipts: a ? 52000000 : 23000000, disbursements: a ? 41000000 : 20000000, last_cash_on_hand_end_period: a ? 11000000 : 3000000, individual_unitemized_contributions: a ? 21000000 : 6000000, individual_itemized_contributions: a ? 24000000 : 9000000, other_political_committee_contributions: a ? 2000000 : 3000000, political_party_committee_contributions: 50000, candidate_contribution: a ? 0 : 1000000, loans_made_by_candidate: a ? 0 : 2500000, coverage_end_date: '2026-10-14T00:00:00' }] });
    }
    if (u.pathname === '/fec/schedules/schedule_a/by_state/by_candidate/') {
      const a = u.searchParams.get('candidate_id') === 'S6GA00001';
      return json({ results: [{ state: 'GA', total: a ? 8000000 : 6000000 }, { state: 'CA', total: a ? 9000000 : 1000000 }, { state: 'NY', total: a ? 7000000 : 2000000 }] });
    }
    if (u.pathname === '/fec/schedules/schedule_e/by_candidate/') {
      const a = u.searchParams.get('candidate_id') === 'S6GA00001';
      return json({ results: [
        { committee_id: 'C1', committee_name: 'TEST SUPER PAC ONE', support_oppose_indicator: a ? 'S' : 'O', total: 12000000 },
        { committee_id: 'C2', committee_name: 'TEST PARTY COMMITTEE', support_oppose_indicator: a ? 'O' : 'S', total: 15000000 },
      ] });
    }
    if ((m = u.pathname.match(/^\/fec\/committee\/(\w+)\/reports\/$/))) {
      const scale = m[1] === 'C00000001' ? 1 : 0.45;
      const ends = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30', '2026-10-14'];
      return json({ results: ends.map((e, i) => ({ coverage_end_date: `${e}T00:00:00`, total_receipts_period: Math.round((3e6 + i * 1.2e6) * scale), cash_on_hand_end_period: Math.round((4e6 + i * 0.9e6) * scale), receipt_date: e })) });
    }
    // ---- fake Harvard Dataverse (MIT Election Lab) ----
    if (u.pathname === '/dataverse/api/datasets/:persistentId/') {
      const doi = u.searchParams.get('persistentId');
      const id = /PEJ5QU/.test(doi) ? 1 : /IG0UN2/.test(doi) ? 2 : 3;
      const name = { 1: '1976-2020-senate.csv', 2: '1976-2024-house.tab', 3: '1976-2024-president.csv' }[id];
      return json({ data: { latestVersion: { files: [{ dataFile: { id: 100 + id, filename: 'readme.pdf' } }, { dataFile: { id, originalFileName: name, filename: name, filesize: 1000 } }] } } });
    }
    if ((m = u.pathname.match(/^\/dataverse\/api\/access\/datafile\/(\d)$/))) {
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      return res.end({ 1: SENATE_CSV, 2: HOUSE_CSV, 3: PRES_CSV }[m[1]]);
    }
    // ---- fake VoteView ----
    if (u.pathname === '/voteview/members/HSall_members.csv') { res.writeHead(200); return res.end(VV_MEMBERS); }
    if (u.pathname === '/voteview/votes/S119_votes.csv') { res.writeHead(200); return res.end(VV_S_VOTES); }
    if (u.pathname === '/voteview/rollcalls/S119_rollcalls.csv') { res.writeHead(200); return res.end(VV_S_ROLLS); }
    if (u.pathname === '/voteview/votes/H119_votes.csv') { res.writeHead(200); return res.end('congress,chamber,rollnumber,icpsr,cast_code,prob\n119,House,1,99904,1,99\n'); }
    if (u.pathname === '/voteview/rollcalls/H119_rollcalls.csv') { res.writeHead(200); return res.end('congress,chamber,rollnumber,date,vote_result\n119,House,1,2025-01-10,Passed\n'); }
    // ---- fake Congress.gov ----
    if ((m = u.pathname.match(/^\/congress\/member\/(\w+)$/))) return json({ member: { directOrderName: 'Test Candidate-A', terms: [{ chamber: 'Senate', congress: 117, startYear: 2021, endYear: 2023, stateCode: 'GA' }, { chamber: 'Senate', congress: 118, startYear: 2023, endYear: 2025, stateCode: 'GA' }, { chamber: 'Senate', congress: 119, startYear: 2025, stateCode: 'GA' }], sponsoredLegislation: { count: 42 } } });
    // ---- fake House Clerk ----
    if (u.pathname === '/clerk/financial-pdfs/2026FD.zip') { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(makeZip('2026FD.xml', CLERK_XML)); }
    // ---- fake Senate eFD ----
    if (u.pathname === '/efd/search/home/' && req.method === 'GET') { res.writeHead(200, { 'Set-Cookie': 'csrftoken=tok123; Path=/', 'Content-Type': 'text/html' }); return res.end('<form><input type="hidden" name="csrfmiddlewaretoken" value="formtok"></form>'); }
    if (u.pathname === '/efd/search/home/' && req.method === 'POST') { res.writeHead(302, { 'Set-Cookie': 'sessionid=sess1; Path=/', Location: '/efd/search/' }); return res.end(); }
    if (u.pathname === '/efd/search/report/data/') {
      if (!/sessionid=sess1/.test(req.headers.cookie || '')) { res.writeHead(403); return res.end('{}'); }
      return json({ data: [
        ['Test', 'Candidate-A', 'Candidate-A, Test (Senator)', '<a href="/efd/search/view/ptr/abc-123/" target="_blank">Periodic Transaction Report for 03/01/2026</a>', '03/05/2026'],
        ['Test', 'Candidate-A', 'Candidate-A, Test (Senator)', '<a href="/efd/search/view/annual/def-456/" target="_blank">Annual Report for CY 2025</a>', '05/15/2026'],
      ] });
    }
    if (u.pathname === '/efd/search/view/ptr/abc-123/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<table><tbody><tr><td>1</td><td>02/20/2026</td><td>Spouse</td><td>TSTX</td><td>Test Fixture Corp (TEST)</td><td>Stock</td><td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr></tbody></table>'); }
    res.writeHead(404);
    res.end('{}');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setInterval(() => tick++, 20_000);
  createMock().listen(PORT, () => console.log(`TEST mock upstream on :${PORT}`));
}
