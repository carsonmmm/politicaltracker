// Watchlist (starred races, kept in this browser) and in-app alerts for watched races.
import { esc, pct } from './ui.js';

const KEY = 'watchlist';
const BASE_KEY = 'watchBaselines';
const ODDS_MOVE = 0.10; // alert when market-implied chance moves 10+ points

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const watched = () => new Set(read(KEY, []));
export const isWatched = (id) => watched().has(id);
export function toggleWatch(id, summary) {
  const w = watched();
  if (w.has(id)) w.delete(id);
  else {
    w.add(id);
    if (summary) setBaseline(summary);
  }
  write(KEY, [...w]);
  document.dispatchEvent(new CustomEvent('watch-change', { detail: { id } }));
  return w.has(id);
}

export function starButton(s) {
  const on = isWatched(s.id);
  return `<button type="button" class="star" data-star="${esc(s.id)}" aria-pressed="${on}" aria-label="${on ? 'Remove from' : 'Add to'} watchlist: ${esc(s.label)}" title="${on ? 'Watching — click to remove' : 'Watch this race'}">${on ? '★' : '☆'}</button>`;
}

/** One delegated handler for every star button on the page. */
export function wireStars(getSummary) {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-star]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const on = toggleWatch(b.dataset.star, getSummary(b.dataset.star));
    document.querySelectorAll(`[data-star="${CSS.escape(b.dataset.star)}"]`).forEach((x) => {
      x.setAttribute('aria-pressed', String(on));
      x.textContent = on ? '★' : '☆';
    });
  });
}

const lean = (odds) => (odds?.D !== undefined ? odds.D : odds?.R !== undefined ? 1 - odds.R : odds?.Y !== undefined ? odds.Y : null);
function setBaseline(s) {
  const b = read(BASE_KEY, {});
  b[s.id] = { called: Boolean(s.call), p: lean(s.odds), at: new Date().toISOString() };
  write(BASE_KEY, b);
}

/** Compare watched races with their baselines; return alert messages (and update baselines). */
export function checkAlerts(races) {
  const w = watched();
  if (!w.size) return [];
  const b = read(BASE_KEY, {});
  const out = [];
  for (const s of races) {
    if (!w.has(s.id)) continue;
    const base = b[s.id];
    if (!base) { setBaseline(s); continue; }
    if (s.call && !base.called) {
      out.push({ id: s.id, kind: 'call', text: `${s.label}: ${s.office === 'BM' ? (/^yes/i.test(s.call.winner) ? 'passed' : 'failed') : `${s.call.winner} wins`} — called by ${s.call.calledBy}` });
      b[s.id] = { ...base, called: true };
    } else if (!s.call && base.called) {
      out.push({ id: s.id, kind: 'call', text: `${s.label}: the earlier call is no longer shown by the source` });
      b[s.id] = { ...base, called: false };
    }
    const p = lean(s.odds);
    if (p !== null && base.p !== null && base.p !== undefined && Math.abs(p - base.p) >= ODDS_MOVE) {
      const side = s.office === 'BM' ? 'pass' : s.odds.D !== undefined ? 'Democrat' : 'Republican';
      out.push({ id: s.id, kind: 'odds', text: `${s.label}: market-implied chance for ${side} moved ${p > base.p ? 'up' : 'down'} ${Math.round(Math.abs(p - base.p) * 100)} points (${pct(base.p)} → ${pct(p)})` });
      b[s.id] = { ...b[s.id], p };
    } else if (p !== null && (base.p === null || base.p === undefined)) b[s.id] = { ...b[s.id], p };
  }
  write(BASE_KEY, b);
  return out;
}

// ---------- toasts ----------
let tray;
export function toast(a) {
  if (!tray) {
    tray = document.createElement('div');
    tray.className = 'toasts';
    tray.setAttribute('role', 'status');
    tray.setAttribute('aria-live', 'polite');
    document.body.appendChild(tray);
  }
  const el = document.createElement('div');
  el.className = `toast ${a.kind}`;
  el.innerHTML = `<a href="#/race/${encodeURIComponent(a.id)}">${esc(a.text)}</a><button type="button" aria-label="Dismiss">×</button>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  tray.appendChild(el);
  setTimeout(() => el.remove(), 30_000);
  try {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Midterm Live', { body: a.text });
  } catch {}
}
