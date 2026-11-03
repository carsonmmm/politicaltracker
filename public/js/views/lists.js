import { esc, pct, chip, statusTag, leadText, oddsText, oddsBar, raceLink, src, patch, ago, dateTimeET, OFFICE_NAME, STATUS_LABEL, PARTY_NAME } from '../ui.js';
import { lineChart } from '../chart.js';

// ---------------- Races list with search and filters ----------------
export const races = {
  async mount(root, ctx) {
    const f = (ctx.ui.filters ||= { q: '', office: '', tier: '', status: '' });
    root.innerHTML = `<h1>All races</h1>
      <div class="filters" role="search">
        <input id="q" type="search" placeholder="Search candidate, state or district (e.g. PA-07)" value="${esc(f.q)}" aria-label="Search">
        <select id="office" aria-label="Office"><option value="">All offices</option>${['S', 'G', 'H', 'BM'].map((o) => `<option value="${o}">${OFFICE_NAME[o]}</option>`).join('')}</select>
        <select id="tier" aria-label="Tier"><option value="">All tiers</option><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option></select>
        <select id="status" aria-label="Status"><option value="">Any status</option>${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      </div>
      <div data-k="table"></div>`;
    for (const id of ['q', 'office', 'tier', 'status']) {
      const el = root.querySelector(`#${id}`);
      el.value = f[id];
      el.addEventListener('input', () => { f[id] = el.value; ctx.saveUi(); this.update(root, ctx); });
    }
    this.update(root, ctx);
  },
  update(root, ctx) {
    const f = ctx.ui.filters;
    const q = f.q.trim().toLowerCase();
    let rows = ctx.state.races.filter((r) => (!f.office || r.office === f.office) && (!f.tier || String(r.tier) === f.tier) && (!f.status || r.status === f.status));
    if (q) rows = rows.filter((r) => `${r.label} ${r.stateName} ${r.state} ${r.id} ${r.leader?.name || ''} ${r.call?.winner || ''}`.toLowerCase().includes(q));
    rows.sort((a, b) => a.tier - b.tier || a.office.localeCompare(b.office) || a.label.localeCompare(b.label, 'en', { numeric: true }));
    patch(root, {
      table: `<p class="small muted">${rows.length} races. Candidate search covers names reported by a results feed or entered in Admin.</p>
      <div class="table-scroll"><table><thead><tr><th>Race</th><th>Tier</th><th>Status</th><th>Leader / winner</th><th>Expected vote</th><th>Market-implied</th></tr></thead><tbody>
      ${rows.slice(0, 600).map((r) => `<tr><td><a href="${raceLink(r)}"><b>${esc(r.label)}</b></a></td><td>${r.tier}</td><td>${statusTag(r)}</td><td class="small">${leadText(r)}</td><td class="num">${r.pctExpected != null ? `${r.pctExpected}%` : '—'}</td><td class="small" style="min-width:140px">${oddsText(r.odds)}</td></tr>`).join('')}
      </tbody></table></div>`,
    });
  },
};

// ---------------- Odds ----------------
export const odds = {
  async mount(root, ctx) {
    root.innerHTML = `<h1>Odds</h1>
      <p class="small muted">All figures are <b>market-implied chances</b> from Kalshi and Polymarket — what traders are paying, not a forecast by this site. Kalshi volume is in contracts (each pays $1); Polymarket volume is in U.S. dollars. Markets under the low-volume threshold are flagged as less reliable.</p>
      <div class="grid g2"><section class="panel" data-k="control"></section><section class="panel" data-k="movers"></section></div>
      <section class="panel" style="margin-top:16px" data-k="mve"></section>
      <section class="panel" style="margin-top:16px" data-k="table"></section>`;
    await this.update(root, ctx);
  },
  async update(root, ctx) {
    const s = ctx.state;
    let control = null;
    try { control = await fetch('/api/control').then((r) => r.json()); } catch {}
    const byId = Object.fromEntries(s.races.map((r) => [r.id, r]));
    const controlHtml = ['CONTROL-S', 'CONTROL-H'].map((id) => {
      const v = control?.[id];
      const name = id === 'CONTROL-S' ? 'Senate control' : 'House control';
      if (!v?.n) return `<h3>${name}</h3><p class="empty">Not available — no control market matched, or the market feeds are unreachable.</p>`;
      const series = new Map();
      for (const r of v.history || []) {
        if (!r.party) continue;
        const k = `${r.source}|${r.party}`;
        if (!series.has(k)) series.set(k, { label: `${r.source}: ${PARTY_NAME[r.party]}`, color: r.party === 'D' ? 'var(--dem)' : r.party === 'R' ? 'var(--rep)' : 'var(--oth)', dash: r.source === 'Polymarket', points: [] });
        series.get(k).points.push({ t: r.t, p: r.p });
      }
      return `<h3>${name}</h3><div>${oddsText(v.avg)}</div>${oddsBar(v.avg)}
        <table><tbody>${v.sources.map((x) => `<tr><td>${esc(x.source)}</td><td>${oddsText(x.parties)}</td><td class="small">${x.volume_unit === 'USD' ? '$' : ''}${Intl.NumberFormat('en-US', { notation: 'compact' }).format(x.volume || 0)}${x.volume_unit === 'contracts' ? ' contracts' : ''}${x.low_volume ? ' <span class="tag warn">Low volume</span>' : ''}</td></tr><tr><td colspan="3">${src(x)}</td></tr>`).join('')}</tbody></table>
        ${lineChart([...series.values()], { height: 160, title: `${name} odds history` })}`;
    }).join('<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">');
    const movers = s.movers.length
      ? `<div class="table-scroll"><table><thead><tr><th>Race</th><th>Outcome</th><th class="r">1 h ago</th><th class="r">Now</th><th class="r">Change</th></tr></thead><tbody>${s.movers.map((m) => `<tr><td><a href="#/race/${encodeURIComponent(m.raceId)}">${esc(byId[m.raceId]?.label || m.raceId)}</a><div class="src">${esc(m.source)}</div></td><td>${chip(m.party)} ${esc(m.label)}</td><td class="r num">${pct(m.from)}</td><td class="r num">${pct(m.to)}</td><td class="r num"><b>${m.delta > 0 ? '+' : ''}${Math.round(m.delta * 100)} pts</b></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">Not available — needs at least an hour of saved odds history.</p>';
    const mve = s.marketsVsExperts.length
      ? `<div class="table-scroll"><table><thead><tr><th>Race</th><th>Rating</th><th>Markets</th><th>Why flagged</th></tr></thead><tbody>${s.marketsVsExperts.map((m) => `<tr><td><a href="#/race/${encodeURIComponent(m.raceId)}">${esc(m.label)}</a></td><td>${esc(m.rating.rating)}<div class="src"><a href="${esc(m.rating.source_url)}" target="_blank" rel="noopener">${esc(m.rating.outlet)}</a>, ${esc(m.rating.date)}</div></td><td>${oddsText(m.odds)}</td><td class="small">${esc(m.rule)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">No disagreements found. This needs both entered ratings and matched markets.</p>';
    const withOdds = s.races.filter((r) => r.oddsSources.length).sort((a, b) => Math.abs((a.odds.D ?? 0.5) - 0.5) - Math.abs((b.odds.D ?? 0.5) - 0.5));
    const table = withOdds.length
      ? `<div class="table-scroll"><table><thead><tr><th>Race</th><th>Average</th><th>Sources</th><th>Status</th></tr></thead><tbody>${withOdds.map((r) => `<tr><td><a href="${raceLink(r)}"><b>${esc(r.label)}</b></a></td><td style="min-width:150px">${oddsText(r.odds)}${oddsBar(r.odds)}</td><td class="small">${r.oddsSources.map((o) => `${esc(o.source)}${o.stale ? ' <span class="tag stale">Stale</span>' : ''}${o.low_volume ? ' <span class="tag warn">Low vol</span>' : ''}`).join('<br>')}</td><td>${statusTag(r)}</td></tr>`).join('')}</tbody></table></div><p class="tiny muted">Sorted closest to 50/50 first. Open a race for side-by-side prices and volume.</p>`
      : '<p class="empty">Not available — no race markets matched yet (feeds unreachable or still loading). See Sources.</p>';
    patch(root, {
      control: `<header><h2>Chamber control</h2></header>${controlHtml}`,
      movers: `<header><h2>Biggest movers, last hour</h2></header>${movers}`,
      mve: `<header><h2>Markets vs. experts</h2><span class="small muted">Rule: flagged when a rating favours a party (Lean or stronger) but markets give that party under 50%, or a Toss-up rating while markets give one side 80%+.</span></header>${mve}`,
      table: `<header><h2>All races with markets (${withOdds.length})</h2></header>${table}`,
    });
  },
};

// ---------------- Sources ----------------
const RESULT_LABEL = { reachable: ['Reachable', ''], needs_key: ['Needs key', 'warn'], unreachable: ['Unreachable', 'bad'], error: ['Error', 'bad'] };
export const sources = {
  async mount(root, ctx) {
    root.innerHTML = `<h1>Data sources</h1>
      <p class="small muted">The server fetches every source itself, so browser CORS rules do not block the app. This page shows what the server can reach right now and how each live feed is doing.</p>
      <section class="panel" data-k="feeds"></section>
      <section class="panel" style="margin-top:16px"><header><h2>Reachability test</h2><button class="btn ghost" id="rerun" type="button">Run test again</button></header><div data-k="probe"></div></section>`;
    root.querySelector('#rerun').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Testing…';
      await fetch('/api/probe', { method: 'POST' });
      e.target.disabled = false;
      e.target.textContent = 'Run test again';
      this.update(root, ctx, { force: true });
    });
    this.update(root, ctx);
  },
  async update(root, ctx, opts = {}) {
    const data = await fetch('/api/sources').then((r) => r.json());
    const feeds = Object.entries(data.feeds || {});
    patch(root, {
      feeds: `<header><h2>Live feeds</h2></header><div class="table-scroll"><table><thead><tr><th>Feed</th><th>Status</th><th>Last success</th><th>Refresh</th><th>Detail</th></tr></thead><tbody>
        ${feeds.map(([n, f]) => `<tr><td><b>${esc(n)}</b></td><td><span class="tag ${f.status === 'ok' ? '' : f.status === 'unconfigured' ? 'warn' : 'bad'}">${esc(f.status === 'unconfigured' ? 'Not configured' : f.status)}</span></td><td class="small">${f.last_ok ? `<time datetime="${esc(f.last_ok)}">${esc(ago(f.last_ok))}</time>` : 'never'}</td><td class="small">${f.interval_ms ? `${Math.round(f.interval_ms / 1000)} s` : 'on edit'}</td><td class="small">${f.last_error ? esc(f.last_error) : ''}${f.markets != null ? `${esc(f.markets)} markets matched` : ''}${f.records != null ? `${esc(f.records)} records` : ''}${f.races_cached != null ? `${esc(f.races_cached)} races cached, ${esc(f.races_refreshed)} refreshed last pass · ${esc(f.key)}` : ''}${f.partial_errors?.length ? `<br><span class="muted">${f.partial_errors.map(esc).join('<br>')}</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div>`,
      probe: data.probe
        ? `<p class="small muted">Last run ${esc(dateTimeET(data.probe.ran_at))}</p><div class="table-scroll"><table><thead><tr><th>Source</th><th>Used for</th><th>Result</th><th>Key</th><th>Detail</th></tr></thead><tbody>${data.probe.rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td class="small">${esc(r.use)}</td><td><span class="tag ${RESULT_LABEL[r.result]?.[1] || ''}">${esc(RESULT_LABEL[r.result]?.[0] || r.result)}</span></td><td class="small">${esc(r.key)}</td><td class="small">${esc(r.detail)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">Test has not run yet.</p>',
    }, opts.force);
  },
};
