import { esc, chip, patch, notAvailable, PARTY_NAME } from '../ui.js';
import { headline, breakdown, financeSource } from '../finance.js';

export async function mount(root, ctx) {
  root.innerHTML = `<div data-k="head"><p class="muted">Loading candidate…</p></div>
    <div class="grid g2" style="margin-top:12px">
      <section class="panel" aria-label="Biography" data-k="bio"></section>
      <section class="panel" aria-label="Political history" data-k="history"></section>
    </div>
    <section class="panel" style="margin-top:16px" aria-label="Policy positions" data-k="positions"></section>
    <div class="grid g2" style="margin-top:16px">
      <section class="panel" aria-label="Campaign finance" data-k="finance"></section>
      <div class="grid" style="align-content:start">
        <section class="panel" aria-label="Endorsements" data-k="endorse"></section>
        <section class="panel" aria-label="Voting record" data-k="votes"></section>
        <section class="panel" aria-label="Personal finances" data-k="personal"></section>
      </div>
    </div>`;
  await update(root, ctx, { force: true });
}

export async function update(root, ctx, { force } = {}) {
  const r = await fetch(`/api/candidate/${encodeURIComponent(ctx.params.raceId)}/${encodeURIComponent(ctx.params.slug)}`);
  if (!r.ok) {
    root.innerHTML = `<p>Candidate not found. <a href="#/race/${encodeURIComponent(ctx.params.raceId)}">Back to the race</a></p>`;
    return;
  }
  const d = await r.json();
  document.title = `${d.candidate.name} — Midterm Live`;
  patch(root, { head: head(d), bio: bio(d.profile), history: history(d.profile), positions: positions(d.profile), finance: finance(d), endorse: endorse(d.profile), votes: votes(d), personal: personal() }, force);
}

const link = (url, text = 'source') => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : '');

function head(d) {
  const p = d.profile;
  return `<p class="small"><a href="#/race/${encodeURIComponent(d.race.id)}">← ${esc(d.race.label)}</a></p>
    <h1>${chip(p.party)} ${esc(p.name)}</h1>
    <div class="status-line"><span class="tag">${esc(PARTY_NAME[p.party] || p.party_label || 'Other')}</span>${p.incumbent ? '<span class="tag">Incumbent</span>' : ''}<span class="tag">${esc(d.race.label)}</span>
    ${p.researched ? `<span class="src">Profile from ${esc(p.origins.join(' + '))}${p.updated_at ? `, updated ${esc(p.updated_at.slice(0, 10))}` : ''}</span>` : '<span class="tag warn">Profile not yet researched</span>'}</div>
    ${d.opponents.length ? `<p class="small">Also in this race: ${d.opponents.map((o) => `<a href="#/candidate/${encodeURIComponent(d.race.id)}/${encodeURIComponent(o.slug)}">${esc(o.name)}</a>`).join(', ')} · <a href="#/race/${encodeURIComponent(d.race.id)}">compare side by side</a></p>` : ''}`;
}

const NR = '<span class="muted">Not yet researched</span>';
function bio(p) {
  const b = p.bio || {};
  const list = (v) => (Array.isArray(v) && v.length ? v.map(esc).join('<br>') : v ? esc(v) : NR);
  return `<header><h2>Biography</h2>${b.source_url ? `<span class="src">${link(b.source_url)}</span>` : ''}</header>
    <dl class="kv">
      <dt>Age</dt><dd>${b.age != null ? `${esc(b.age)}${b.birth_date ? ` <span class="tiny muted">(born ${esc(b.birth_date)})</span>` : ''}` : NR}</dd>
      <dt>Hometown</dt><dd>${b.hometown ? esc(b.hometown) : NR}</dd>
      <dt>Education</dt><dd>${list(b.education)}</dd>
      <dt>Career before politics</dt><dd>${list(b.career)}</dd>
    </dl>`;
}

function history(p) {
  const offices = p.offices.length ? `<ul class="feed">${p.offices.map((o) => `<li><b>${esc(o.title)}</b> <span class="small muted">${esc(o.from || '')}${o.to !== undefined ? `–${esc(o.to || 'present')}` : ''}</span> <span class="src">${link(o.source_url)}</span></li>`).join('')}</ul>` : `<p class="empty">${p.researched ? 'No offices held on record.' : 'Not yet researched.'}</p>`;
  const elections = p.elections.length ? `<table><thead><tr><th>Year</th><th>Office</th><th>Result</th><th class="r">Share</th></tr></thead><tbody>${p.elections.map((e) => `<tr><td>${esc(e.year)}</td><td>${esc(e.office)}</td><td>${esc(e.result || '')} <span class="src">${link(e.source_url)}</span></td><td class="r num">${e.pct != null ? `${esc(e.pct)}%` : '—'}</td></tr>`).join('')}</tbody></table>` : `<p class="empty">${p.researched ? 'No past elections on record.' : 'Not yet researched.'}</p>`;
  const roles = p.roles.length ? `<ul class="feed">${p.roles.map((o) => `<li>${esc(o.title)} <span class="src">${link(o.source_url)}</span></li>`).join('')}</ul>` : `<p class="empty">${p.researched ? 'None on record.' : 'Not yet researched.'}</p>`;
  return `<header><h2>Political history</h2></header><h3>Offices held</h3>${offices}<h3 style="margin-top:10px">Past elections</h3>${elections}<h3 style="margin-top:10px">Committee seats and leadership roles</h3>${roles}`;
}

function positions(p) {
  return `<header><h2>Policy positions</h2><span class="small muted">Same ten issues for every candidate. Summaries are based on the candidate's own statements, with a link to each one.</span></header>
    <div class="table-scroll"><table><tbody>${Object.values(p.positions).map((x) => `<tr><th scope="row" style="width:28%;text-transform:none;letter-spacing:0;font-size:.9rem;color:var(--ink)">${esc(x.label)}</th><td>${
      x.status === 'stated' ? `${esc(x.summary)}<div class="src">${link(x.source_url, "Candidate's statement")}${x.date ? ` · ${esc(x.date)}` : ''}</div>`
      : x.status === 'none' ? `<span>No stated position found.</span><div class="src">Checked ${esc(x.checked_at)}</div>`
      : '<span class="muted">Not yet researched</span>'}</td></tr>`).join('')}</tbody></table></div>`;
}

function endorse(p) {
  const e = p.endorsements;
  return `<header><h2>Endorsements</h2></header>${e.length ? `<ul class="feed">${e.map((x) => `<li><b>${esc(x.name)}</b>${x.type ? ` <span class="tag">${esc(x.type)}</span>` : ''}${x.date ? ` <span class="small muted">${esc(x.date)}</span>` : ''} <span class="src">${link(x.source_url)}</span></li>`).join('')}</ul>` : `<p class="empty">${p.researched ? 'No notable endorsements on record.' : 'Not yet researched.'}</p>`}`;
}

function finance(d) {
  const f = d.finance;
  let html = '<header><h2>Campaign finance</h2><span class="small muted">Raw figures, no score or grade</span></header>';
  if (!f?.available) return html + notAvailable(f?.reason || 'no finance data');
  if (!f.mine) return html + notAvailable('no FEC filing could be matched to this candidate by name. An admin can link the FEC candidate ID.') + financeSource(f);
  return html + headline(f.mine) + breakdown(f.mine) + `<div style="margin-top:8px">${financeSource(f)} ${f.match === 'name' ? '<span class="tiny muted">Matched to FEC by last name and party.</span>' : ''}</div>`;
}

function votes(d) {
  return `<header><h2>Voting record</h2></header>${notAvailable(d.profile.incumbent || d.profile.offices.length ? 'key votes and ideology scores (Congress.gov, VoteView) arrive in Phase 4' : 'not applicable unless the candidate has held office; voting records arrive in Phase 4')}`;
}

function personal() {
  return `<header><h2>Personal finances and stock trades</h2></header>${notAvailable('House Clerk and Senate financial disclosure filings arrive in Phase 4')}`;
}
