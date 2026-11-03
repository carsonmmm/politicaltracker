import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from './mock-upstream.js';
import { displayName, fecLastName, fecParty, reportHistory, createFecAdapter } from '../server/adapters/fec.js';
import { validateProfile, validateMoment, buildProfile, ageOn, candidateKey, ISSUES } from '../server/profiles.js';

test('FEC name helpers', () => {
  assert.equal(displayName('OSSOFF, T. JONATHAN'), 'T. Jonathan Ossoff');
  assert.equal(displayName('SMITH, JOHN JR.'), 'John Smith Jr');
  assert.equal(displayName('COLLINS, MICHAEL A JR'), 'Michael A. Collins Jr');
  assert.equal(displayName('MCCOLUMN, JONATHAN MR'), 'Jonathan Mccolumn');
  assert.equal(fecLastName('CANDIDATE-A, TEST'), 'candidate-a');
  assert.equal(fecParty('DEMOCRATIC PARTY'), 'D');
  assert.equal(fecParty('REPUBLICAN PARTY'), 'R');
  assert.equal(fecParty('LIBERTARIAN PARTY'), 'O');
});

test('report history keeps the latest filing per period and accumulates receipts', () => {
  const h = reportHistory([
    { coverage_end_date: '2026-03-31', total_receipts_period: 100, receipt_date: '2026-04-10' },
    { coverage_end_date: '2026-03-31', total_receipts_period: 120, receipt_date: '2026-05-01' }, // amendment wins
    { coverage_end_date: '2025-12-31', total_receipts_period: 50, cash_on_hand_end_period: 40 },
  ]);
  assert.deepEqual(h.map((x) => x.receipts_cum), [50, 170]);
});

test('FEC adapter against the fake upstream: summary and full detail', async () => {
  const srv = createMock().listen(0);
  const port = srv.address().port;
  process.env.FEC_BASE = `http://localhost:${port}/fec`;
  try {
    const { createFecAdapter: fresh } = await import(`../server/adapters/fec.js?x=${port}`);
    const fec = fresh({ perHour: 1e7 });
    const rows = await fec.raceSummary({ office: 'S', state: 'GA' });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, 'Test Candidate-A');
    assert.equal(rows[0].party, 'D');
    assert.ok(rows[0].incumbent);
    const d = await fec.candidateDetail(rows[1], 'GA');
    assert.equal(d.small_individual, 6000000);
    assert.equal(d.self_loans, 2500000);
    assert.equal(d.itemized_in_state, 6000000);
    assert.equal(d.itemized_out_state, 3000000);
    assert.equal(d.outside_for_total, 15000000);
    assert.equal(d.outside_against[0].name, 'TEST SUPER PAC ONE');
    assert.equal(d.history.length, 8);
    assert.equal(fec.calls(), 5);
  } finally {
    srv.close();
    delete process.env.FEC_BASE;
  }
});

test('profile validation requires sources everywhere', () => {
  assert.deepEqual(validateProfile({ raceId: 'S-GA', name: 'A' }), []);
  assert.match(validateProfile({ raceId: 'S-GA', name: 'A', bio: { hometown: 'X' } }).join(), /bio: source_url/);
  assert.match(validateProfile({ raceId: 'S-GA', name: 'A', positions: { economy: { summary: 'x' } } }).join(), /positions.economy: source_url/);
  assert.match(validateProfile({ raceId: 'S-GA', name: 'A', positions: { economy: { none: true } } }).join(), /checked_at/);
  assert.match(validateProfile({ raceId: 'S-GA', name: 'A', positions: { taxes: { summary: 'x', source_url: 'https://x' } } }).join(), /unknown issue/);
  assert.match(validateProfile({ raceId: 'S-GA', name: 'A', endorsements: [{ name: 'Z' }] }).join(), /endorsements\[0\]/);
  assert.match(validateMoment({ raceId: 'S-GA', date: '2026-10-01', type: 'controversy', text: 'x' }).join(), /source_url/);
  assert.deepEqual(validateMoment({ raceId: 'S-GA', date: '2026-10-01', type: 'debate', text: 'x', source_url: 'https://x' }), []);
});

test('every profile has all ten issues, distinguishing unresearched from none found', () => {
  const p = buildProfile({ raceId: 'S-GA', name: 'A' }, { positions: { economy: { summary: 'S', source_url: 'https://x' }, guns: { none: true, checked_at: '2026-11-01' } } }, null);
  assert.equal(Object.keys(p.positions).length, ISSUES.length);
  assert.equal(p.positions.economy.status, 'stated');
  assert.equal(p.positions.guns.status, 'none');
  assert.equal(p.positions.health.status, 'unresearched');
  const blank = buildProfile({ raceId: 'S-GA', name: 'B' }, null, null);
  assert.equal(blank.researched, false);
  assert.ok(Object.values(blank.positions).every((x) => x.status === 'unresearched'));
});

test('manual profile fields override research; age derives from birth date', () => {
  const p = buildProfile({ raceId: 'S-GA', name: 'A' }, { bio: { hometown: 'Old', birth_date: '1980-11-04', source_url: 'https://r' } }, { bio: { hometown: 'New' } });
  assert.equal(p.bio.hometown, 'New');
  assert.equal(ageOn('1980-11-04', new Date('2026-11-03T12:00:00Z')), 45);
  assert.equal(ageOn('1980-11-03', new Date('2026-11-03T12:00:00Z')), 46);
  assert.equal(candidateKey('S-GA', 'Sen. Jane Q. Doe'), 'S-GA:jane-doe');
});
