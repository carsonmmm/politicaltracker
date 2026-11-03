import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchMarket, partyFromLabel, nameKey } from '../server/lib/match.js';
import { kalshiPrice, normalizeEvent as kalshiNorm } from '../server/adapters/kalshi.js';
import { normalizeEvent as polyNorm } from '../server/adapters/polymarket.js';
import { normalizeAp, validateEntry } from '../server/adapters/results.js';
import { buildCatalog } from '../server/engine.js';

test('catalog has 35 Senate, 36 governor and 435 House races', () => {
  const c = buildCatalog();
  assert.equal(c.filter((r) => r.office === 'S').length, 35);
  assert.equal(c.filter((r) => r.office === 'G').length, 36);
  assert.equal(c.filter((r) => r.office === 'H').length, 435);
  assert.ok(c.find((r) => r.id === 'S-OH').special);
  assert.ok(c.find((r) => r.id === 'H-WY-00'));
});

test('market title matching', () => {
  const m = (title, extra = {}) => matchMarket({ title, ...extra })?.raceId ?? null;
  assert.equal(m('Georgia Senate Election Winner 2026'), 'S-GA');
  assert.equal(m('Who will win the West Virginia Senate race?'), 'S-WV');
  assert.equal(m('Virginia Senate 2026'), 'S-VA');
  assert.equal(m('Pennsylvania Governor Election 2026'), 'G-PA');
  assert.equal(m('PA-07 House race 2026'), 'H-PA-07');
  assert.equal(m("Who will win New York's 17th congressional district?"), 'H-NY-17');
  assert.equal(m('Which party will control the Senate after 2026?'), 'CONTROL-S');
  assert.equal(m('Which party will win the House in 2026?'), 'CONTROL-H');
  assert.equal(m('Georgia Senate Republican primary winner'), null, 'primaries excluded');
  assert.equal(m('Georgia Senate 2028'), null, 'other cycles excluded');
  assert.equal(m('Ohio Senate special election 2026'), 'S-OH');
  assert.equal(m('anything', { seriesTicker: 'SENATEGA' }), 'S-GA');
  assert.equal(m('anything', { seriesTicker: 'CONTROLH' }), 'CONTROL-H');
  assert.equal(m('PA-99 House race'), null, 'invalid district');
});

test('party labels and names', () => {
  assert.equal(partyFromLabel('Democratic party'), 'D');
  assert.equal(partyFromLabel('Republican'), 'R');
  assert.equal(partyFromLabel('Jane Doe (R)'), 'R');
  assert.equal(partyFromLabel('Independent'), 'O');
  assert.equal(partyFromLabel('Jane Doe'), null);
  assert.equal(nameKey('Sen. Jane Q. Doe Jr.'), 'jane doe');
});

test('kalshi price: midpoint when tight, last trade otherwise, dollar fields preferred', () => {
  assert.equal(kalshiPrice({ yes_bid: 50, yes_ask: 52, last_price: 40 }), 0.51);
  assert.equal(kalshiPrice({ yes_bid: 10, yes_ask: 60, last_price: 40 }), 0.4);
  assert.equal(kalshiPrice({ yes_bid_dollars: '0.6100', yes_ask_dollars: '0.6300' }), 0.62);
  assert.equal(kalshiPrice({}), null);
  const rec = kalshiNorm({ event: { event_ticker: 'E', series_ticker: 'SENATEGA', title: 't' }, markets: [{ ticker: 'E-D', yes_sub_title: 'Dem nominee', yes_bid: 50, yes_ask: 52, volume: 10 }, { ticker: 'E-R', yes_sub_title: 'Someone', last_price: 48, volume: 5 }] }, { raceId: 'S-GA' });
  assert.equal(rec.outcomes[1].party, 'R', 'falls back to ticker suffix');
  assert.equal(rec.volume, 15);
  assert.ok(rec.source && rec.source_url && rec.fetched_at);
});

test('polymarket normalization handles multi-market and named-outcome events', () => {
  const multi = polyNorm({ slug: 's', title: 'GA', markets: [
    { id: 1, groupItemTitle: 'Democratic', outcomes: '["Yes","No"]', outcomePrices: '["0.55","0.45"]', volumeNum: 10 },
    { id: 2, groupItemTitle: 'Republican', outcomes: '["Yes","No"]', outcomePrices: '["0.45","0.55"]', volumeNum: 10 },
  ] }, 'S-GA');
  assert.deepEqual(multi.outcomes.map((o) => [o.party, o.price]), [['D', 0.55], ['R', 0.45]]);
  const named = polyNorm({ slug: 's2', title: 'H', markets: [{ id: 3, outcomes: '["Democratic","Republican"]', outcomePrices: '["0.6","0.4"]' }] }, 'CONTROL-H');
  assert.deepEqual(named.outcomes.map((o) => o.party), ['D', 'R']);
  assert.equal(named.volume_unit, 'USD');
});

test('AP normalization: calls only from winner flag, House at-large, counties', () => {
  const recs = normalizeAp({ races: [
    { officeID: 'S', statePostal: 'GA', reportingUnits: [{ level: 'state', eevp: 40, candidates: [{ first: 'A', last: 'One', party: 'Dem', voteCount: 10 }, { first: 'B', last: 'Two', party: 'GOP', voteCount: 9 }] }, { level: 'FIPSCode', fipsCode: '13121', candidates: [{ first: 'A', last: 'One', party: 'Dem', voteCount: 5 }] }] },
    { officeID: 'H', statePostal: 'WY', seatNum: '1', reportingUnits: [{ level: 'state', candidates: [{ first: 'C', last: 'Three', party: 'GOP', voteCount: 5, winner: 'X' }] }] },
  ] });
  assert.equal(recs[0].raceId, 'S-GA');
  assert.equal(recs[0].call, null, 'leading is not a call');
  assert.equal(recs[0].status, 'counting');
  assert.equal(recs[0].counties.length, 1);
  assert.equal(recs[1].raceId, 'H-WY-00');
  assert.equal(recs[1].call.calledBy, 'AP');
});

test('research file entries must cite a source and name the calling outlet', () => {
  const base = { raceId: 'S-GA', source: 'x', source_url: 'https://x', fetched_at: '2026-11-03T00:00:00Z', candidates: [] };
  assert.equal(validateEntry(base), null);
  assert.match(validateEntry({ ...base, source_url: undefined }), /source/);
  assert.match(validateEntry({ ...base, status: 'called' }), /calledBy/);
  assert.equal(validateEntry({ ...base, status: 'called', call: { winner: 'A', calledBy: 'AP' } }), null);
  assert.match(validateEntry({ ...base, status: 'won' }), /unknown status/);
});
