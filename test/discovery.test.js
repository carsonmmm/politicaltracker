import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from './mock-upstream.js';

async function withMock(fn) {
  const srv = createMock().listen(0);
  const port = srv.address().port;
  process.env.KALSHI_BASE = `http://localhost:${port}/kalshi`;
  try {
    const { createKalshiAdapter } = await import(`../server/adapters/kalshi.js?p=${port}${Math.random()}`);
    await fn(createKalshiAdapter);
  } finally {
    srv.close();
    delete process.env.KALSHI_BASE;
    delete process.env.MOCK_NO_SERIES;
  }
}

test('Kalshi discovery uses election series when available', () =>
  withMock(async (create) => {
    const k = create({});
    const r = await k.discover();
    assert.equal(r.method, 'series');
    const ids = [...k.getKnown().values()].map((v) => v.raceId);
    assert.ok(ids.includes('S-GA') && ids.includes('CONTROL-S') && ids.includes('G-PA') && ids.includes('S-NC'));
    const { records } = await k.refresh();
    assert.equal(records.find((x) => x.raceId === 'S-NC').outcomes[0].price, 0.58);
  }));

test('Kalshi discovery falls back to paging all events', () =>
  withMock(async (create) => {
    process.env.MOCK_NO_SERIES = '1';
    const k = create({});
    const r = await k.discover();
    assert.equal(r.method, 'paging');
    assert.ok([...k.getKnown().values()].some((v) => v.raceId === 'S-GA'));
    assert.ok(!k.getUnmatched().some((x) => /game/i.test(x.title)), 'sports ignored');
  }));
