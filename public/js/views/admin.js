import { esc, dateTimeET } from '../ui.js';

const STATUSES = { not_reporting: 'Not yet reporting', counting: 'Counting — not called', too_early: 'Too early to call', too_close: 'Too close to call', called: 'Called', recount: 'Recount', runoff: 'Runoff' };
const RATINGS = ['Solid D', 'Likely D', 'Lean D', 'Tilt D', 'Toss-up', 'Tilt R', 'Lean R', 'Likely R', 'Solid R'];
let token = '';
try { token = sessionStorage.getItem('adminToken') || ''; } catch {}

async function api(action, body) {
  const r = await fetch(`/api/admin/${action}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function mount(root, ctx) {
  if (!token || !(await api('check').then(() => true).catch(() => false))) return login(root, ctx);
  const raceOpts = ctx.state.races.map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');
  root.innerHTML = `<h1>Admin</h1>
    <p class="small muted">Everything entered here is labelled <span class="tag manual">Manual</span> in the app and must cite a source. A race can only be marked called with the name of the outlet that called it.</p>
    <datalist id="races">${raceOpts}<option value="CONTROL-S">Senate control</option><option value="CONTROL-H">House control</option></datalist>
    <div class="grid g2">
      <section class="panel"><h2>Enter or correct a result</h2>
        <form class="admin" id="f-result">
          <label>Race ID <input name="raceId" list="races" required placeholder="S-GA, G-PA, H-CA-13"></label>
          <label>Status <select name="status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label>Candidates — one per line: Name | Party (D/R/I/O) | Votes<textarea name="cands" rows="4" placeholder="Jane Doe | D | 120345"></textarea></label>
          <div class="row2"><label>% of expected vote counted <input name="pctExpected" type="number" min="0" max="100" step="0.1"></label>
          <label>Count type <select name="kind"><option value="unofficial">Unofficial</option><option value="certified">Certified</option></select></label></div>
          <fieldset style="border:1px solid var(--line);border-radius:6px"><legend class="small">Race call (only if a named outlet called it)</legend>
            <div class="row2"><label>Winner <input name="winner"></label><label>Called by <input name="calledBy" list="outlets" placeholder="AP"></label></div>
            <datalist id="outlets"><option>AP</option><option>Decision Desk HQ</option><option>NBC News Decision Desk</option><option>CNN Decision Desk</option><option>Fox News Decision Desk</option><option>ABC News Decision Desk</option><option>CBS News Decision Desk</option></datalist>
            <label>Call source URL <input name="callUrl" type="url"></label>
          </fieldset>
          <label>Which ballots are still out <input name="outstanding" placeholder="e.g. Mail ballots in X County, counted Thursday (per county clerk)"></label>
          <div class="row2"><label>Source name <input name="source" required placeholder="Georgia SoS results page"></label><label>Source URL <input name="source_url" type="url" required></label></div>
          <button class="btn">Save result</button><div class="msg" data-msg></div>
        </form></section>
      <section class="panel"><h2>Add a candidate</h2>
        <form class="admin" id="f-cand">
          <label>Race ID <input name="raceId" list="races" required></label>
          <div class="row2"><label>Name <input name="name" required></label><label>Party <select name="party"><option>D</option><option>R</option><option value="I">Independent</option><option value="L">Libertarian</option><option value="G">Green</option><option value="O">Other</option></select></label></div>
          <label><span><input type="checkbox" name="incumbent" style="width:auto"> Incumbent</span></label>
          <label>Source URL (official site, Ballotpedia, state candidate list) <input name="source_url" type="url" required></label>
          <button class="btn">Save candidate</button><div class="msg" data-msg></div>
        </form>
        <h2 style="margin-top:18px">Add an expert rating</h2>
        <form class="admin" id="f-rating">
          <label>Race ID <input name="raceId" list="races" required></label>
          <div class="row3"><label>Outlet <input name="outlet" list="raters" required></label><label>Rating <select name="rating">${RATINGS.map((r) => `<option>${r}</option>`).join('')}</select></label><label>Date <input name="date" type="date" required></label></div>
          <datalist id="raters"><option>Cook Political Report</option><option>Sabato's Crystal Ball</option><option>Inside Elections</option></datalist>
          <label>Source URL <input name="source_url" type="url" required></label>
          <button class="btn">Save rating</button><div class="msg" data-msg></div>
        </form>
      </section>
      <section class="panel"><h2>Add a polling average</h2>
        <form class="admin" id="f-poll">
          <label>Race ID <input name="raceId" list="races" required></label>
          <div class="row2"><label>Whose average <input name="average" required placeholder="e.g. RealClearPolitics"></label><label>As of <input name="date" type="date" required></label></div>
          <label>Values — one per line: Name | Percent<textarea name="values" rows="3"></textarea></label>
          <label>Source URL <input name="source_url" type="url" required></label>
          <button class="btn">Save average</button><div class="msg" data-msg></div>
        </form>
        <h2 style="margin-top:18px">Ballots-out note</h2>
        <form class="admin" id="f-note">
          <label>Race ID <input name="raceId" list="races" required></label>
          <label>Note (leave blank to clear) <textarea name="text" rows="2"></textarea></label>
          <label>Source URL <input name="source_url" type="url"></label>
          <button class="btn">Save note</button><div class="msg" data-msg></div>
        </form>
      </section>
      <section class="panel"><h2>Unmatched markets</h2><p class="small muted">Election markets the title matcher could not place. Map each to a race ID, or leave the box empty and save to ignore it.</p><div id="unmatched"><p class="empty">Loading…</p></div></section>
      <section class="panel"><h2>Chamber baseline (seats not up)</h2>
        <form class="admin" id="f-chamber"><textarea name="json" rows="12" class="num" style="font-family:var(--mono);font-size:.8rem"></textarea>
        <label><span><input type="checkbox" name="verified" style="width:auto"> I checked these numbers against an official source</span></label>
        <label>Source URL <input name="source_url" type="url"></label>
        <button class="btn">Save baseline</button><div class="msg" data-msg></div></form></section>
      <section class="panel"><h2>Poll closing time</h2>
        <form class="admin" id="f-pc"><div class="row3"><label>State <input name="state" maxlength="2" required placeholder="GA"></label><label>First close (ET) <input name="first" placeholder="19:00" required></label><label>Last close (ET) <input name="last" placeholder="19:00 or 00:00+1" required></label></div>
        <label>Source URL <input name="source_url" type="url"></label>
        <button class="btn">Save</button><div class="msg" data-msg></div></form></section>
    </div>
    <section class="panel" style="margin-top:16px"><h2>Manual entries</h2><div id="entries"></div></section>`;
  wire(root, ctx);
  loadSide(root, ctx);
}

function login(root, ctx) {
  root.innerHTML = `<h1>Admin</h1><section class="panel" style="max-width:420px"><form class="admin" id="login"><label>Admin token <input name="t" type="password" autocomplete="current-password" required></label><p class="small muted">The token is printed in the server console at startup (or set ADMIN_TOKEN).</p><button class="btn">Sign in</button><div class="msg" data-msg></div></form></section>`;
  root.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = e.target.t.value.trim();
    try {
      await api('check');
      try { sessionStorage.setItem('adminToken', token); } catch {}
      mount(root, ctx);
    } catch (err) {
      e.target.querySelector('[data-msg]').className = 'msg err';
      e.target.querySelector('[data-msg]').textContent = err.message;
    }
  });
}

const lines = (s) => s.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0]);

function wire(root, ctx) {
  const on = (id, build) => {
    const f = root.querySelector(id);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = f.querySelector('[data-msg]');
      try {
        const [action, body] = build(f);
        await api(action, body);
        msg.className = 'msg ok';
        msg.textContent = `Saved at ${new Date().toLocaleTimeString()}.`;
        loadSide(root, ctx);
      } catch (err) {
        msg.className = 'msg err';
        msg.textContent = err.message;
      }
    });
  };
  on('#f-result', (f) => {
    const cands = lines(f.cands.value).map(([name, party, votes]) => ({ name, party: (party || 'O').toUpperCase().replace(/^I$/, 'O'), votes: Number(String(votes || 0).replace(/,/g, '')) }));
    const body = { raceId: f.raceId.value.trim(), status: f.status.value, candidates: cands, pctExpected: f.pctExpected.value, kind: f.kind.value, source: f.source.value.trim(), source_url: f.source_url.value.trim(), outstanding_note: f.outstanding.value.trim() };
    if (f.winner.value.trim() || f.status.value === 'called') body.call = { winner: f.winner.value.trim(), calledBy: f.calledBy.value.trim(), source_url: f.callUrl.value.trim() || undefined };
    if (body.call && body.status !== 'called') throw new Error('Set status to "Called" when entering a call.');
    return ['result', body];
  });
  on('#f-cand', (f) => ['candidate', { raceId: f.raceId.value.trim(), name: f.name.value.trim(), party: f.party.value, incumbent: f.incumbent.checked, source_url: f.source_url.value.trim() }]);
  on('#f-rating', (f) => ['rating', { raceId: f.raceId.value.trim(), outlet: f.outlet.value.trim(), rating: f.rating.value, date: f.date.value, source_url: f.source_url.value.trim() }]);
  on('#f-poll', (f) => ['poll', { raceId: f.raceId.value.trim(), average: f.average.value.trim(), date: f.date.value, source_url: f.source_url.value.trim(), values: lines(f.values.value).map(([name, p]) => ({ name, pct: Number(p) })) }]);
  on('#f-note', (f) => ['note', { raceId: f.raceId.value.trim(), text: f.text.value.trim(), source_url: f.source_url.value.trim() || null }]);
  on('#f-pc', (f) => ['poll-closing', { state: f.state.value.trim().toUpperCase(), first: f.first.value.trim(), last: f.last.value.trim(), source_url: f.source_url.value.trim() }]);
  on('#f-chamber', (f) => {
    let j;
    try { j = JSON.parse(f.json.value); } catch { throw new Error('Baseline is not valid JSON'); }
    return ['chamber', { ...j, verified: f.verified.checked, source_url: f.source_url.value.trim() || j.source_url, source: f.verified.checked ? 'Manual (verified)' : 'Manual' }];
  });
  // Pre-fill the result form from the current record when a race is chosen.
  root.querySelector('#f-result').raceId.addEventListener('change', async (e) => {
    const r = await fetch(`/api/race/${encodeURIComponent(e.target.value)}`).then((x) => (x.ok ? x.json() : null));
    const f = root.querySelector('#f-result');
    if (!r) return;
    const p = r.results.primary;
    const cands = p?.candidates?.length ? p.candidates : r.candidates;
    f.cands.value = cands.map((c) => `${c.name} | ${c.party} | ${c.votes ?? 0}`).join('\n');
    if (p) { f.status.value = p.status; f.pctExpected.value = p.pctExpected ?? ''; }
  });
}

async function loadSide(root, ctx) {
  const [manual, unmatched] = await Promise.all([api('manual'), api('unmatched')]);
  const f = root.querySelector('#f-chamber');
  if (!f.json.value) {
    const base = manual.chamber || null;
    const st = ctx.state.balance;
    f.json.value = JSON.stringify(base ? { senate: base.senate, house: base.house, governors: base.governors } : { senate: { total: st.senate.total, majority: st.senate.majority, tiebreak: st.senate.tiebreak, not_up: st.senate.not_up }, house: { total: st.house.total, majority: st.house.majority, not_up: st.house.not_up }, governors: { total: st.governors.total, majority: st.governors.majority, not_up: st.governors.not_up } }, null, 2);
  }
  const um = Object.values(unmatched).flat();
  const uel = root.querySelector('#unmatched');
  uel.innerHTML = um.length
    ? `<div class="table-scroll"><table><tbody>${um.map((m, i) => `<tr><td class="small"><b>${esc(m.source)}</b>: ${esc(m.title)}<div class="tiny muted">${esc(m.key)}</div></td><td><form data-key="${esc(m.key)}" style="display:flex;gap:4px"><input name="rid" list="races" placeholder="race ID" style="width:110px"><button class="btn ghost">Save</button></form></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">No unmatched election markets (or the market feeds are unreachable).</p>';
  uel.querySelectorAll('form').forEach((fm) => fm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('market-map', { key: fm.dataset.key, raceId: fm.rid.value.trim() || null });
    fm.innerHTML = '<span class="msg ok">Saved — applies on next refresh</span>';
  }));
  const rows = [];
  for (const [rid, r] of Object.entries(manual.results)) rows.push(['result', rid, 0, `${r.status}${r.call ? ` — called for ${r.call.winner} by ${r.call.calledBy}` : ''}; ${r.candidates.map((c) => `${c.name} ${c.votes}`).join(', ')}`, r.fetched_at]);
  for (const [rid, list] of Object.entries(manual.candidates)) list.forEach((c, i) => rows.push(['candidate', rid, i, `${c.name} (${c.party_label || c.party})`, c.entered_at]));
  const idx = {};
  for (const r of manual.ratings) { idx[`rating${r.raceId}`] = (idx[`rating${r.raceId}`] ?? -1) + 1; rows.push(['rating', r.raceId, idx[`rating${r.raceId}`], `${r.outlet}: ${r.rating} (${r.date})`, r.entered_at]); }
  for (const r of manual.polls) { idx[`poll${r.raceId}`] = (idx[`poll${r.raceId}`] ?? -1) + 1; rows.push(['poll', r.raceId, idx[`poll${r.raceId}`], `${r.average}: ${r.values.map((v) => `${v.name} ${v.pct}%`).join(', ')} (${r.date})`, r.entered_at]); }
  const el = root.querySelector('#entries');
  el.innerHTML = rows.length
    ? `<div class="table-scroll"><table><thead><tr><th>Type</th><th>Race</th><th>Entry</th><th>Entered</th><th></th></tr></thead><tbody>${rows.map(([k, rid, i, text, at]) => `<tr><td>${esc(k)}</td><td><a href="#/race/${encodeURIComponent(rid)}">${esc(rid)}</a></td><td class="small">${esc(text)}</td><td class="small">${esc(dateTimeET(at))}</td><td><button class="btn ghost" data-del="${esc(JSON.stringify({ kind: k, raceId: rid, index: i }))}">Delete</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">No manual entries yet.</p>';
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this manual entry?')) return;
    await api('delete', JSON.parse(b.dataset.del));
    loadSide(root, ctx);
  }));
}
