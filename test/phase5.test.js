import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-p5-'));
const { Engine } = await import('../server/engine.js');

const now = () => new Date().toISOString();
const result = (raceId, cands, extra = {}) => ({ raceId, source: 'Manual', manual: true, source_url: 'https://x', fetched_at: now(), status: 'counting', pctExpected: 50, call: null, candidates: cands, ...extra });

test('uncalled tracker: margin, implied votes left, excludes called and runoff races', () => {
  const e = new Engine();
  e.ingestResults('Manual', [
    result('S-GA', [{ name: 'A', party: 'D', votes: 500 }, { name: 'B', party: 'R', votes: 498 }], { pctExpected: 40 }),
    result('S-NC', [{ name: 'C', party: 'R', votes: 600 }, { name: 'D', party: 'D', votes: 400 }], { status: 'called', call: { winner: 'C', party: 'R', calledBy: 'AP' } }),
    result('H-GA-14', [{ name: 'E', party: 'R', votes: 5, advances: true }, { name: 'F', party: 'R', votes: 4, advances: true }], { status: 'runoff' }),
  ]);
  const a = e.state().after;
  assert.deepEqual(a.uncalled.map((u) => u.id), ['S-GA']);
  assert.equal(a.uncalled[0].remainingImplied, 1497, '998 / 0.4 - 998');
  assert.equal(a.uncalled[0].marginVotes, 2);
  assert.equal(a.runoffs[0].id, 'H-GA-14');
  assert.deepEqual(a.runoffs[0].candidates.map((c) => c.name), ['E', 'F']);
});

test('recount watch uses the state threshold', () => {
  const e = new Engine();
  e.ingestResults('Manual', [
    result('S-MI', [{ name: 'A', party: 'D', votes: 2_501_000 }, { name: 'B', party: 'R', votes: 2_499_500 }]), // 1,500 votes: within MI 2,000
    result('S-NC', [{ name: 'C', party: 'R', votes: 5050 }, { name: 'D', party: 'D', votes: 4950 }]), // 1 pt: NC request 0.5 -> not within, not near (2x = 1.0 => near)
    result('S-TX', [{ name: 'E', party: 'R', votes: 501 }, { name: 'F', party: 'D', votes: 499 }]), // TX has no rule entered
  ]);
  const w = e.state().after.recount.watch;
  const mi = w.find((x) => x.id === 'S-MI');
  assert.ok(mi.within);
  assert.ok(!w.some((x) => x.id === 'S-TX'));
  const nc = w.find((x) => x.id === 'S-NC');
  assert.ok(nc && !nc.within, 'NC within twice the margin only');
});

test('expected vs actual scores the pre-election favourite and skips ties', () => {
  const e = new Engine();
  const pre = '2026-11-02T12:00:00.000Z';
  e.ingestOddsHistory([
    { t: pre, raceId: 'S-ME', source: 'Kalshi', market_id: 'd', party: 'D', p: 0.3 },
    { t: pre, raceId: 'S-ME', source: 'Kalshi', market_id: 'r', party: 'R', p: 0.7 },
    { t: pre, raceId: 'G-PA', source: 'Kalshi', market_id: 'd', party: 'D', p: 0.5 },
    { t: pre, raceId: 'G-PA', source: 'Kalshi', market_id: 'r', party: 'R', p: 0.5 },
  ]);
  e.manual.ratings.push({ raceId: 'S-ME', outlet: 'Test', rating: 'Lean R', date: '2026-10-30', source_url: 'https://x' });
  e.ingestResults('Manual', [
    result('S-ME', [{ name: 'A', party: 'D', votes: 51 }, { name: 'B', party: 'R', votes: 49 }], { status: 'called', call: { winner: 'A', party: 'D', calledBy: 'AP' } }),
    result('G-PA', [{ name: 'C', party: 'D', votes: 51 }, { name: 'D', party: 'R', votes: 49 }], { status: 'called', call: { winner: 'C', party: 'D', calledBy: 'AP' } }),
  ]);
  const ex = e.state().after.expected;
  const me = ex.rows.find((r) => r.id === 'S-ME');
  assert.equal(me.market.fav, 'R');
  assert.equal(me.market.hit, false);
  assert.equal(me.rating.hit, false);
  assert.equal(ex.rows.find((r) => r.id === 'G-PA').market.fav, null, 'tie has no favourite');
  assert.deepEqual(ex.summary.market, { hits: 0, misses: 1 });
});
