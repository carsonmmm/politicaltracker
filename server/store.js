// Persistence: small JSON files plus append-only JSONL history, under data/runtime/.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, writeJsonAtomic } from './lib/util.js';

export const RUNTIME = process.env.DATA_DIR || path.join(ROOT, 'data', 'runtime');
fs.mkdirSync(path.join(RUNTIME, 'history'), { recursive: true });

const file = (name) => path.join(RUNTIME, name);

export const store = {
  load(name, fallback) {
    return readJson(file(name), fallback);
  },
  save(name, data) {
    writeJsonAtomic(file(name), data);
  },
  append(name, rows) {
    if (!rows.length) return;
    fs.appendFileSync(file(path.join('history', name)), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  },
  readHistory(name, { sinceMs = 0 } = {}) {
    const f = file(path.join('history', name));
    if (!fs.existsSync(f)) return [];
    const rows = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (!sinceMs || Date.parse(r.t) >= sinceMs) rows.push(r);
      } catch {
        /* skip a torn line */
      }
    }
    return rows;
  },
};
