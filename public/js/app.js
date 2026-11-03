import { esc, ago } from './ui.js';
import * as dashboard from './views/dashboard.js';
import * as race from './views/race.js';
import * as lists from './views/lists.js';
import * as admin from './views/admin.js';
import * as sim from './views/sim.js';
import * as candidate from './views/candidate.js';
import * as after from './views/after.js';
import { wireStars, checkAlerts, toast } from './watch.js';

const app = document.getElementById('app');
const liveEl = document.getElementById('live');
const banner = document.getElementById('banner');

export const ctx = {
  state: null,
  params: {},
  ui: loadUi(),
  saveUi() {
    try { localStorage.setItem('ui', JSON.stringify(this.ui)); } catch {}
  },
};
function loadUi() {
  try { return { mapOffice: 'S', mapMode: 'leader', ...JSON.parse(localStorage.getItem('ui') || '{}') }; } catch { return { mapOffice: 'S', mapMode: 'leader' }; }
}

const routes = [
  [/^#?\/?$/, dashboard],
  [/^#\/race\/(.+)$/, race, (m) => ({ id: decodeURIComponent(m[1]) })],
  [/^#\/candidate\/([^/]+)\/([^/?]+)$/, candidate, (m) => ({ raceId: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) })],
  [/^#\/races$/, lists.races],
  [/^#\/odds$/, lists.odds],
  [/^#\/sources$/, lists.sources],
  [/^#\/admin$/, admin],
  [/^#\/after$/, after],
  [/^#\/sim(?:\?(.*))?$/, sim, (m) => ({ query: m[1] || '' })],
];

let current = null;
async function route() {
  const h = location.hash || '#/';
  for (const [re, view, params] of routes) {
    const m = h.match(re);
    if (m) {
      ctx.params = params ? params(m) : {};
      current = view;
      document.querySelectorAll('.nav a').forEach((a) => a.toggleAttribute('aria-current', a.getAttribute('href') === h.split('?')[0] || ((h.startsWith('#/race/') || h.startsWith('#/candidate/')) && a.getAttribute('href') === '#/races')));
      if (current.mount) { a11yTitle(); await current.mount(app, ctx); }
      else { app.innerHTML = current.render(ctx); }
      window.scrollTo(0, 0);
      return;
    }
  }
  app.innerHTML = '<p>Page not found. <a href="#/">Back to dashboard</a></p>';
}
function a11yTitle() { app.focus({ preventScroll: true }); }

async function fetchState() {
  const r = await fetch('/api/state');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  ctx.state = await r.json();
  renderChrome();
}

function renderChrome() {
  const s = ctx.state;
  if (!s) return;
  const feeds = Object.entries(s.feeds || {});
  const oddsOk = ['Kalshi', 'Polymarket'].some((n) => s.feeds[n]?.status === 'ok');
  const problems = feeds.filter(([, f]) => f.status === 'error');
  const resultsLive = ['AP', 'Decision Desk HQ'].some((n) => s.feeds[n]?.status === 'ok');
  liveEl.className = `live ${sseUp && oddsOk ? 'on' : 'down'}`;
  liveEl.textContent = sseUp ? (oddsOk ? 'Live' : 'Live · feeds down') : 'Disconnected';
  const msgs = [];
  if (problems.length) msgs.push(`Feed down: ${problems.map(([n, f]) => `${esc(n)} (${esc(f.last_error)})`).join('; ')}.`);
  const stateSites = s.feeds['State election office']?.status === 'ok';
  if (!resultsLive) msgs.push(stateSites
    ? 'No outlet results feed (AP / Decision Desk HQ need a paid key). Vote counts come from state election sites, which do not call races, plus the research file and manual entries.'
    : 'No live vote-count feed (AP / Decision Desk HQ need a paid key). Results come from the research file and manual entries only.');
  const anyStale = s.races.some((r) => r.oddsSources.some((o) => o.stale));
  if (anyStale) msgs.push('Some odds are from the last saved snapshot and are marked Stale.');
  if (!sseUp) msgs.push('Lost connection to the server; numbers shown may be out of date.');
  banner.hidden = msgs.length === 0;
  banner.className = `banner ${problems.length || !sseUp ? 'bad' : ''}`;
  banner.innerHTML = msgs.join(' ') + ' <a href="#/sources">Source status</a>';
}

let sseUp = false;
let pending = null;
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => { sseUp = true; refresh(); });
  es.addEventListener('update', () => {
    // Coalesce bursts of updates into one refetch.
    if (pending) return;
    pending = setTimeout(() => { pending = null; refresh(); }, 1500);
  });
  es.onerror = () => { sseUp = false; renderChrome(); };
}

let alertsReady = false;
async function refresh() {
  try {
    await fetchState();
    // The first load only records baselines; later updates raise alerts for watched races.
    const alerts = checkAlerts(ctx.state.races);
    if (alertsReady) alerts.forEach(toast);
    alertsReady = true;
    if (current?.update) current.update(app, ctx);
  } catch (err) {
    banner.hidden = false;
    banner.className = 'banner bad';
    banner.textContent = `Could not load data from the server: ${err.message}`;
  }
}

document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
  current?.update?.(app, ctx, { force: true });
});

// Relative times ("2 min ago") tick without refetching.
setInterval(() => {
  document.querySelectorAll('time[datetime]').forEach((t) => {
    const iso = t.getAttribute('datetime');
    if (iso && t.textContent.startsWith('updated')) t.textContent = `updated ${ago(iso)}`;
  });
  current?.tick?.(app, ctx);
}, 1000);

window.addEventListener('hashchange', route);
wireStars((id) => ctx.state?.races.find((r) => r.id === id));
document.addEventListener('watch-change', () => current?.update?.(app, ctx));
(async () => {
  try { await fetchState(); } catch (err) { banner.hidden = false; banner.className = 'banner bad'; banner.textContent = `Could not reach the Midterm Live server: ${err.message}`; }
  await route();
  connect();
})();

