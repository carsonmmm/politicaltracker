import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMock } from './mock-upstream.js';
import { contestToRace, parseClaritySummary, createStateSitesAdapter } from '../server/adapters/state-sites.js';

test('state contest names map to races, other offices are ignored', () => {
  assert.equal(contestToRace('NV', 'United States Senator'), 'S-NV');
  assert.equal(contestToRace('GA', 'US Senate'), 'S-GA');
  assert.equal(contestToRace('NV', 'Governor'), 'G-NV');
  assert.equal(contestToRace('NV', 'Lieutenant Governor'), null);
  assert.equal(contestToRace('NV', 'U.S. Representative, District 3'), 'H-NV-03');
  assert.equal(contestToRace('PA', 'Representative in Congress 7th District'), 'H-PA-07');
  assert.equal(contestToRace('WY', 'U.S. Representative'), 'H-WY-00');
  assert.equal(contestToRace('NV', 'State Senate District 4'), null);
  assert.equal(contestToRace('NV', 'U.S. Representative, District 9'), null, 'NV has 4 seats');
  assert.equal(contestToRace('FL', 'Amendment 4'), 'BM-FL-4');
});

test('Clarity summary parses the compact and verbose forms', () => {
  const a = parseClaritySummary([{ C: 'US Senate', CH: ['Jane Doe (DEM)', 'John Roe (REP)', 'Write-in'], P: ['DEM', 'REP', ''], V: ['10', '9', '1'], PR: 5, TP: 10 }], 'GA');
  assert.deepEqual(a[0].candidates, [{ name: 'Jane Doe', party: 'D', votes: 10 }, { name: 'John Roe', party: 'R', votes: 9 }]);
  assert.deepEqual(a[0].precincts, { reported: 5, total: 10 });
  const b = parseClaritySummary({ Contests: [{ contestName: 'Governor', choices: [{ name: 'A', party: 'Democratic', votes: 3 }, { name: 'B', party: 'Republican', votes: 4 }] }] }, 'GA');
  assert.equal(b[0].raceId, 'G-GA');
  assert.equal(b[0].candidates[1].party, 'R');
});

test('state sites adapter reads configured feeds and never calls a race', async () => {
  const srv = createMock().listen(0);
  const port = srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-ss-'));
  const file = path.join(dir, 'feeds.json');
  fs.writeFileSync(file, JSON.stringify({ feeds: [{ state: 'NV', type: 'clarity', url: `http://localhost:${port}/clarity/NV/1/`, name: 'NV SoS (test)' }, { state: 'ZZ', type: 'other', url: 'x' }] }));
  process.env.STATE_FEEDS_FILE = file;
  try {
    const { records, errors } = await createStateSitesAdapter({}).refresh();
    assert.deepEqual(records.map((r) => r.raceId).sort(), ['G-NV', 'H-NV-03', 'S-NV']);
    assert.ok(records.every((r) => r.call === null && r.pctExpected === null));
    assert.match(records.find((r) => r.raceId === 'G-NV').outstanding_note, /1500 of 2000 precincts/);
    assert.match(errors[0], /unsupported type/);
  } finally {
    srv.close();
    delete process.env.STATE_FEEDS_FILE;
  }
});

test('with no feeds configured the adapter reports "not configured"', async () => {
  process.env.STATE_FEEDS_FILE = path.join(os.tmpdir(), 'does-not-exist.json');
  try {
    await assert.rejects(createStateSitesAdapter({}).refresh(), /No state result sites configured/);
  } finally {
    delete process.env.STATE_FEEDS_FILE;
  }
});
