// Regressions found by running the adapters against the real Kalshi / Polymarket APIs (CI smoke test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchMarket } from '../server/lib/match.js';
import { normalizeEvent as kalshiNorm } from '../server/adapters/kalshi.js';
import { normalizeEvent as polyNorm } from '../server/adapters/polymarket.js';

const m = (title, ticker = '', seriesTicker = '') => matchMarket({ title, ticker, seriesTicker })?.raceId ?? null;

test('real Kalshi titles: non-race and other-cycle markets are not races', () => {
  assert.equal(m('When will AP call the Michigan Senate election?', 'KXAPCALLMISEN-26NOV02', 'KXAPCALLMISEN'), null);
  assert.equal(m('Closer Senate Race: Nebraska or Texas?', 'KXCLOSERNETXSEN-26NOV10', 'KXCLOSERNETXSEN'), null);
  assert.equal(m('Louisiana governor winner? (2027)', 'GOVPARTYLA-27', 'GOVPARTYLA'), null);
  assert.equal(m('Who will run for Mississippi Governor in 2027?', 'KXMSGOVRUN-27', 'KXMSGOVRUN'), null);
  assert.equal(m('Closest House race in 2026?', 'KXCLOSESTHOUSE-27JAN03'), null);
});

test('real Kalshi titles: KX-prefixed and classic tickers map to races', () => {
  assert.equal(m('California Governor winner? (Person)', 'KXGOVCA-26', 'KXGOVCA'), 'G-CA');
  assert.equal(m('WA-08 House winner?', 'KXHOUSEWA8-26', 'KXHOUSEWA8'), 'H-WA-08');
  assert.equal(m('FL-13 House winner?', 'HOUSEFL13-26', 'HOUSEFL13'), 'H-FL-13');
  assert.equal(m('Alaska U.S. House winner? (Person)', 'KXALASKAHOUSE-26', 'KXALASKAHOUSE'), 'H-AK-00');
  assert.equal(m('Who will control the House?', 'CONTROLH-2026', 'CONTROLH'), 'CONTROL-H');
  assert.equal(m('Massachusetts Governor winner?', 'GOVPARTYMA-26', 'GOVPARTYMA'), 'G-MA');
});

test('real Polymarket titles: combo and count markets are not races', () => {
  assert.equal(m('ACA credits extended & House Winner 2026?'), null);
  assert.equal(m('How many House seats will the Democrats win in Texas?'), null);
  assert.equal(m('Speaker of the House after the midterms?'), null);
  assert.equal(m('Republicans win Trifecta with Senate Supermajority in midterms?'), null);
  assert.equal(m('Which Senate races will be within 5%?'), null);
  assert.equal(m('Arizona Governor Election Winner'), 'G-AZ');
  assert.equal(m('Which party will win the Senate in 2026?'), 'CONTROL-S');
});

test('Kalshi nested markets are read even when a top-level markets array is empty', () => {
  const rec = kalshiNorm({ event: { event_ticker: 'SENATEIL-26', series_ticker: 'SENATEIL', title: 'Illinois Senate winner?', markets: [{ ticker: 'SENATEIL-26-D', yes_sub_title: 'Democratic party', yes_bid: 95, yes_ask: 97, volume: 1000 }] }, markets: [] }, { raceId: 'S-IL' });
  assert.equal(rec.outcomes.length, 1);
  assert.equal(rec.outcomes[0].price, 0.96);
});

test('Polymarket placeholder outcomes with no price are dropped', () => {
  const rec = polyNorm({ slug: 'x', title: 'Arizona Governor Election Winner', markets: [
    { id: 1, groupItemTitle: 'Katie Hobbs (D)', outcomes: '["Yes","No"]', outcomePrices: '["0.935","0.065"]' },
    { id: 2, groupItemTitle: 'Andy Biggs (R)', outcomes: '["Yes","No"]', outcomePrices: '["0.065","0.935"]' },
    { id: 3, groupItemTitle: 'Option A', outcomes: '["Yes","No"]', outcomePrices: '[]' },
  ] }, 'G-AZ');
  assert.deepEqual(rec.outcomes.map((o) => `${o.party}:${o.price}`), ['D:0.935', 'R:0.065']);
});
