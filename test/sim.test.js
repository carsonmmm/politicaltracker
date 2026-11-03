import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlRule, tally, pathToMajority, simulate, raceProbs, invNorm, normCdf, encodeScenario, decodeScenario } from '../public/js/sim.js';

const senate = { total: 100, majority: 51, tiebreak: { party: 'R' }, not_up: { D: 34, R: 31, I: 0 } };
const race = (id, odds, extra = {}) => ({ id, label: id, odds, status: 'not_reporting', call: null, ...extra });

test('control rule applies the Senate tiebreak', () => {
  const r = controlRule(senate);
  assert.equal(r.need('D'), 51);
  assert.equal(r.need('R'), 50);
  assert.equal(controlRule({ total: 435, majority: 218 }).need('D'), 218);
});

test('raceProbs normalises and fills a missing side', () => {
  assert.deepEqual(raceProbs({ D: 0.6 }), { D: 0.6, R: 0.4, O: 0 });
  const p = raceProbs({ D: 0.55, R: 0.5 });
  assert.ok(Math.abs(p.D + p.R - 1) < 1e-9);
  assert.equal(raceProbs({}), null);
});

test('tally locks called races over picks and counts picks', () => {
  const races = [race('S-A', {}, { status: 'called', call: { party: 'D' } }), race('S-B', {}), race('S-C', {})];
  const t = tally(races, senate, { 'S-A': 'R', 'S-B': 'R' });
  assert.equal(t.seats.D, 35);
  assert.equal(t.seats.R, 32);
  assert.deepEqual(t.overridden, ['S-A']);
  assert.equal(t.open.length, 1);
});

test('path to majority picks the best-priced races and handles secured/impossible', () => {
  const conf = { total: 10, majority: 6, not_up: { D: 3, R: 3 } };
  const races = [race('a', { D: 0.9 }), race('b', { D: 0.2 }), race('c', { D: 0.6 }), race('d', {})];
  const t = tally(races, conf, {});
  const pD = pathToMajority(t, controlRule(conf), 'D');
  assert.equal(pD.need, 3);
  assert.deepEqual(pD.races.map((x) => x.r.id), ['a', 'c', 'b']);
  assert.ok(Math.abs(pD.jointIndep - 0.9 * 0.6 * 0.2) < 1e-9);
  const sec = pathToMajority(tally(races, conf, { a: 'D', b: 'D', c: 'D' }), controlRule(conf), 'D');
  assert.equal(sec.status, 'secured');
  assert.equal(pathToMajority(tally(races, { ...conf, not_up: { D: 0, R: 0 } }, {}), controlRule(conf), 'D').status, 'impossible');
});

test('normal helpers', () => {
  assert.ok(Math.abs(invNorm(0.975) - 1.959964) < 1e-4);
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-4);
  assert.equal(invNorm(0.5), 0);
});

test('simulation keeps each race at its market chance, and swing widens the spread', () => {
  const conf = { total: 21, majority: 11, not_up: { D: 0, R: 0 } };
  const races = Array.from({ length: 21 }, (_, i) => race(`r${i}`, { D: 0.5 }));
  const t = tally(races, conf, {});
  const indep = simulate(t, controlRule(conf), { n: 20000, rho: 0 });
  const linked = simulate(t, controlRule(conf), { n: 20000, rho: 0.8 });
  for (const res of [indep, linked]) {
    assert.ok(Math.abs(res.pD - 0.5) < 0.03, `pD ~ 0.5, got ${res.pD}`);
    assert.ok(Math.abs(res.raceWinsD.r0 - 0.5) < 0.02);
  }
  assert.ok(linked.highD - linked.lowD > indep.highD - indep.lowD + 4, 'shared swing spreads outcomes');
  const tilted = simulate(t, controlRule(conf), { n: 5000, rho: 0, tilt: 0.5 });
  assert.ok(tilted.raceWinsD.r0 > 0.65);
});

test('races with no market are left undecided unless coin-flip is chosen', () => {
  const conf = { total: 3, majority: 2, not_up: { D: 0, R: 0 } };
  const races = [race('a', { D: 0.99 }), race('b', {}), race('c', {})];
  const t = tally(races, conf, {});
  const u = simulate(t, controlRule(conf), { n: 2000 });
  assert.equal(u.unpricedCount, 2);
  assert.ok(u.pDepends > 0.9);
  assert.equal(u.pD, 0);
  const c = simulate(t, controlRule(conf), { n: 8000, rho: 0, unpriced: 'coinflip' });
  assert.ok(Math.abs(c.pD - 0.75) < 0.03, `independent: got ${c.pD}`);
  // Linked at rho=0.5: P(both R) = 1/4 + asin(0.5)/(2*pi), so pD = 2/3.
  const l = simulate(t, controlRule(conf), { n: 8000, rho: 0.5, unpriced: 'coinflip' });
  assert.ok(Math.abs(l.pD - 2 / 3) < 0.03, `linked: got ${l.pD}`);
});

test('share links round-trip and reject junk', () => {
  const sc = { chamber: 'H', picks: { 'H-PA-07': 'D', 'S-GA': 'R' }, rho: 0.35, tilt: -0.2, unpriced: 'coinflip' };
  assert.deepEqual(decodeScenario(encodeScenario(sc)), sc);
  const bad = decodeScenario('c=Z&a=<script>.D,S-GA.X&rho=900');
  assert.equal(bad.chamber, 'S');
  assert.deepEqual(bad.picks, {});
  assert.equal(bad.rho, 1);
});
