import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMock, makeZip } from './mock-upstream.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-p4-'));
const { parseDelimited, buildPast, titleName } = await import('../server/adapters/mit.js');
const { buildVoteview, castLabel, officesFromTerms } = await import('../server/adapters/voteview.js');
const { unzip, parseHouseIndex, parsePtrTable } = await import('../server/adapters/disclosures.js');
const { measureId, validateMeasure, measureSide, thresholdShare } = await import('../server/measures.js');
const { normalizeAp } = await import('../server/adapters/results.js');

test('CSV parser handles quotes, commas, newlines and TSV', () => {
  const rows = parseDelimited('a,b,c\n1,"x, ""y""",3\n4,"multi\nline",6\n');
  assert.equal(rows[0].b, 'x, "y"');
  assert.equal(rows[1].b, 'multi\nline');
  assert.equal(parseDelimited('a\tb\n1\t2\n')[0].b, '2');
});

test('past results keep the same Senate seat and the latest House elections', () => {
  const senate = parseDelimited('year,state_po,stage,special,candidate,party_simplified,candidatevotes,totalvotes\n2020,GA,gen,FALSE,A ONE,DEMOCRAT,10,19\n2020,GA,gen,FALSE,B TWO,REPUBLICAN,9,19\n2018,GA,gen,FALSE,X,REPUBLICAN,1,1\n2016,OH,gen,FALSE,Y,REPUBLICAN,1,1\n2020,GA,gen,TRUE,Z,REPUBLICAN,1,1\n');
  const house = parseDelimited('year,state_po,district,stage,runoff,special,candidate,party,candidatevotes,totalvotes\n2024,AK,0,GEN,FALSE,FALSE,R1,REPUBLICAN,5,9\n2024,AK,0,GEN,FALSE,FALSE,D1,DEMOCRAT,4,9\n2024,AK,0,PRI,FALSE,FALSE,P,REPUBLICAN,99,99\n');
  const p = buildPast({ senate, house });
  assert.deepEqual(p.races['S-GA'].map((e) => e.year), [2020], 'class II only, no specials');
  assert.equal(p.races['S-GA'][0].candidates[0].name, 'A One');
  assert.deepEqual(p.races['S-OH'].map((e) => e.year), [2016], 'OH special fills a class III seat');
  assert.equal(p.races['H-AK-00'][0].candidates.length, 2, 'primary rows excluded');
  assert.equal(titleName('BIDEN, JOSEPH R. JR'), 'Joseph R. Biden Jr');
});

test('VoteView: cast codes, chamber ranks, participation and key votes', () => {
  assert.equal(castLabel(1), 'Yea');
  assert.equal(castLabel(6), 'Nay');
  assert.equal(castLabel(9), 'Not voting');
  assert.equal(castLabel(0), null);
  const members = [
    { congress: '119', chamber: 'Senate', icpsr: '1', state_abbrev: 'GA', party_code: '100', bioname: 'A, B', nominate_dim1: '-0.4' },
    { congress: '119', chamber: 'Senate', icpsr: '2', state_abbrev: 'TX', party_code: '200', bioname: 'C, D', nominate_dim1: '0.5' },
  ];
  const votes = [{ chamber: 'Senate', rollnumber: '7', icpsr: '1', cast_code: '1' }, { chamber: 'Senate', rollnumber: '8', icpsr: '1', cast_code: '9' }];
  const vv = buildVoteview({ members, votes, rollcalls: [{ chamber: 'Senate', rollnumber: '7', date: '2025-03-01', vote_result: 'Passed' }], keyVotes: [{ chamber: 'Senate', rollnumber: 7 }] });
  assert.deepEqual(vv.ranks['Senate|1'], { rank: 1, of: 2 });
  assert.deepEqual(vv.participation['Senate|1'], { cast: 1, missed: 1 });
  assert.equal(vv.keyCasts['Senate|7']['1'], 'Yea');
  assert.equal(vv.rollInfo['Senate|7'].result, 'Passed');
  assert.deepEqual(officesFromTerms([{ chamber: 'House of Representatives', state: 'GA', district: 6, start: 2019, end: 2021 }, { chamber: 'House of Representatives', state: 'GA', district: 6, start: 2021, end: 2023 }, { chamber: 'Senate', state: 'GA', start: 2023, end: null }]),
    [{ title: 'U.S. Representative, GA-6', from: 2019, to: 2023 }, { title: 'U.S. Senator, GA', from: 2023, to: null }]);
});

test('House Clerk ZIP index and Senate PTR table parsing', () => {
  const xml = '<FinancialDisclosure><Member><Last>Doe</Last><First>Jane</First><FilingType>P</FilingType><StateDst>GA06</StateDst><Year>2026</Year><FilingDate>3/1/2026</FilingDate><DocID>200</DocID></Member></FinancialDisclosure>';
  const files = unzip(makeZip('2026FD.xml', xml));
  const idx = parseHouseIndex(files['2026FD.xml'].toString(), 2026);
  assert.equal(idx[0].type_label, 'Periodic Transaction Report (trades)');
  assert.match(idx[0].url, /ptr-pdfs\/2026\/200\.pdf$/);
  const t = parsePtrTable('<tbody><tr><td>1</td><td>01/02/2026</td><td>Self</td><td>--</td><td>US Treasury Bill</td><td>Bond</td><td>Sale</td><td>$15,001 - $50,000</td></tr></tbody>');
  assert.deepEqual(t[0], { date: '01/02/2026', owner: 'Self', ticker: null, asset: 'US Treasury Bill', asset_type: 'Bond', type: 'Sale', amount: '$15,001 - $50,000' });
});

test('Senate eFD flow (terms agreement, search, PTR page) against the fake server', async () => {
  const srv = createMock().listen(0);
  const port = srv.address().port;
  process.env.SENATE_EFD_BASE = `http://localhost:${port}/efd`;
  try {
    const { createSenateEfdAdapter } = await import(`../server/adapters/disclosures.js?p=${port}`);
    const r = await createSenateEfdAdapter({}).search('Candidate-A');
    assert.equal(r.reports.length, 2);
    assert.ok(r.reports[0].ptr);
    assert.equal(r.reports[0].trades[0].ticker, 'TSTX');
    assert.ok(!r.reports[1].ptr);
  } finally {
    srv.close();
    delete process.env.SENATE_EFD_BASE;
  }
});

test('ballot measures: ids, validation, sides, thresholds and AP mapping', () => {
  assert.equal(measureId('CA', 'Proposition 50'), 'BM-CA-50');
  assert.equal(measureId('FL', 'Amendment 4'), 'BM-FL-4');
  assert.equal(measureId('ZZ', 'Prop 1'), null);
  assert.deepEqual(validateMeasure({ state: 'CA', number: 'Prop 1', title: 'T' }), []);
  assert.match(validateMeasure({ state: 'CA', number: 'Prop 1', title: 'T', summary: 'x' }).join(), /summary_source_url/);
  assert.match(validateMeasure({ state: 'CA', number: 'Prop 1', title: 'T', finance: { support: { raised: 1 } } }).join(), /finance.support/);
  assert.equal(measureSide('Yes'), 'Y');
  assert.equal(measureSide('Will Prop 1 pass?'), 'Y');
  assert.equal(measureSide('No'), 'N');
  assert.equal(thresholdShare('60%'), 0.6);
  assert.equal(thresholdShare('majority'), 0.5);
  const recs = normalizeAp({ races: [{ raceID: '9', officeID: 'I', statePostal: 'CA', seatName: 'Proposition 1', reportingUnits: [{ level: 'state', candidates: [{ first: 'Yes', party: 'NP', voteCount: 10, winner: 'X' }, { first: 'No', party: 'NP', voteCount: 5 }] }] }, { raceID: '10', officeID: 'I', statePostal: 'CA', seatName: 'Proposition 2', reportingUnits: [] }] }, (st, label) => (label === 'Proposition 1' ? 'BM-CA-1' : null));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].raceId, 'BM-CA-1');
  assert.equal(recs[0].call.winner, 'Yes');
});
