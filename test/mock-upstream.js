// TEST ONLY. A fake Kalshi / Polymarket / AP server with obviously fake data,
// used to exercise the full pipeline when the real APIs are unreachable.
// Run: node test/mock-upstream.js  then start the app with
//   KALSHI_BASE=http://localhost:9090/kalshi POLYMARKET_BASE=http://localhost:9090/poly \
//   POLYMARKET_CLOB=http://localhost:9090/clob AP_BASE=http://localhost:9090/ap AP_API_KEY=fake npm start
import http from 'node:http';

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
    res.writeHead(404);
    res.end('{}');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setInterval(() => tick++, 20_000);
  createMock().listen(PORT, () => console.log(`TEST mock upstream on :${PORT}`));
}
