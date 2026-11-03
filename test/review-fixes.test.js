import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-review-'));
const { matchMarket, partyFromLabel } = await import('../server/lib/match.js');
const { surnameMatches } = await import('../server/adapters/fec.js');
const { Engine } = await import('../server/engine.js');

const m = (title) => matchMarket({ title })?.raceId ?? null;

test('other offices are not mistaken for tracked races', () => {
  assert.equal(m('Georgia Lieutenant Governor election 2026'), null);
  assert.equal(m('Who will be Georgia Lt. Governor in 2026?'), null);
  assert.equal(m('Michigan State Senate control 2026'), null);
  assert.equal(m('Which party will control the Pennsylvania State House?'), null);
  assert.equal(m('Virginia House of Delegates 2026'), null);
  assert.equal(m('Texas Attorney General race 2026'), null);
  assert.equal(m('Michigan Senate election 2026'), 'S-MI', 'U.S. Senate still matches');
  assert.equal(m('Georgia Governor 2026'), 'G-GA');
});

test('"Rep." is a title, not a party', () => {
  assert.equal(partyFromLabel('Rep. Pat Ryan'), null);
  assert.equal(partyFromLabel('Rep. Pat Ryan (D)'), 'D');
  assert.equal(partyFromLabel('Republican Party'), 'R');
});

test('single-seat House races match without "at-large"', () => {
  assert.equal(m('Who will win the Alaska House race in 2026?'), 'H-AK-00');
  assert.equal(m("Wyoming's U.S. House seat 2026"), 'H-WY-00');
  assert.equal(m('Alaska State House control 2026'), null);
});

test('FEC surnames match compound and apostrophe names', () => {
  assert.ok(surnameMatches("O'ROURKE, ROBERT", "Beto O'Rourke"));
  assert.ok(surnameMatches('DE LA CRUZ, MONICA', 'Monica De La Cruz'));
  assert.ok(surnameMatches('OCASIO-CORTEZ, ALEXANDRIA', 'Alexandria Ocasio-Cortez'));
  assert.ok(surnameMatches('SMITH, JOHN JR', 'John Smith Jr.'));
  assert.ok(surnameMatches('CRUZ, RAFAEL EDWARD', 'Monica De La Cruz'), 'trailing word also matches; party and FEC ID disambiguate');
  assert.ok(!surnameMatches('JONES, A', 'Jane Smith'));
});

test('calls feed marks a call withdrawn when the manual entry is removed', () => {
  const e = new Engine();
  const rec = { raceId: 'S-ME', source: 'Manual', manual: true, source_url: 'https://x', fetched_at: new Date().toISOString(), status: 'called', call: { winner: 'Test X', party: 'R', calledBy: 'AP' }, candidates: [{ name: 'Test X', party: 'R', votes: 5 }] };
  e.ingestResults('Manual', [rec]);
  assert.equal(e.calls[0].winner, 'Test X');
  assert.ok(!e.calls[0].retracted);
  e.ingestResults('Manual', []);
  assert.ok(e.calls[0].retracted, 'withdrawn after deletion');
  e.ingestResults('Manual', [rec]);
  assert.ok(!e.calls[0].retracted, 'restored if the call comes back');
  assert.equal(e.calls.length, 1);
});

test('backfilled history is kept in time order', () => {
  const e = new Engine();
  const now = new Date().toISOString();
  e.ingestOdds('Kalshi', [{ raceId: 'S-GA', source: 'Kalshi', fetched_at: now, volume: 1, outcomes: [{ label: 'D', party: 'D', price: 0.5, market_id: 'M' }] }]);
  e.ingestOddsHistory([{ t: '2026-10-01T00:00:00.000Z', raceId: 'S-GA', source: 'Kalshi', market_id: 'M', party: 'D', p: 0.4 }]);
  const arr = e.oddsHistory.get('S-GA');
  assert.equal(arr.at(-1).t, now);
  assert.equal(arr[0].t, '2026-10-01T00:00:00.000Z');
});
