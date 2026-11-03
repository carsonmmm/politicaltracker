import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const nowIso = () => new Date().toISOString();

export class FetchError extends Error {
  constructor(message, { status, url, kind } = {}) {
    super(message);
    this.status = status;
    this.url = url;
    this.kind = kind; // 'network' | 'http' | 'auth' | 'parse' | 'timeout'
  }
}

export async function fetchJson(url, { timeoutMs = 15000, headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'midterm-live/0.1 (election tracker)', Accept: 'application/json', ...headers },
    });
  } catch (err) {
    const kind = err.name === 'AbortError' ? 'timeout' : 'network';
    throw new FetchError(`${kind === 'timeout' ? 'Timed out' : 'Network error'}: ${err.cause?.code || err.message}`, { url: redact(url), kind });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? 'auth' : 'http';
    throw new FetchError(`HTTP ${res.status} ${res.statusText || ''}`.trim(), { status: res.status, url: redact(url), kind });
  }
  try {
    return await res.json();
  } catch (err) {
    throw new FetchError(`Could not parse JSON: ${err.message}`, { url: redact(url), kind: 'parse' });
  }
}

// Strip API keys from URLs before they are logged or shown.
export function redact(url) {
  return String(url).replace(/(api_?key=)[^&]+/gi, '$1***');
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        out[idx] = { error: err };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
