import { esc, chip, num, patch, notAvailable, PARTY_NAME } from '../ui.js';
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
  patch(root, { head: head(d), bio: bio(d.profile), history: history(d.profile), positions: positions(d.profile), finance: finance(d), endorse: endorse(d.profile), votes: votes(d), personal: personal(d) }, force);
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
  const offices = p.offices.length ? `<ul class="feed">${p.offices.map((o) => `<li><b>${esc(o.title)}</b> <span class="small muted">${esc(o.from || '')}${o.to !== undefined ? `–${esc(o.to || 'present')}` : ''}</span> <span class="src">${link(o.source_url, o.auto || 'source')}</span></li>`).join('')}</ul>${p.offices_source ? `<p class="tiny muted">Congressional terms from ${esc(p.offices_source)}; other offices are added by research.</p>` : ''}` : `<p class="empty">${p.researched ? 'No offices held on record.' : 'Not yet researched.'}</p>`;
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
  const v = d.voting;
  let html = '<header><h2>Voting record</h2></header>';
  if (!v?.available) return html + notAvailable(v?.reason || 'no voting record');
  const m = v.member;
  const ideo = v.ideology;
  const congressYears = (c) => `${1787 + 2 * c}–${1789 + 2 * c}`;
  html += `<p class="small">${esc(m.bioname)} · ${esc(m.chamber)}, served in the ${m.first_congress}th–${m.last_congress}th Congresses (${congressYears(m.first_congress).split('–')[0]}–${congressYears(m.last_congress).split('–')[1]})${v.match === 'name' ? ' <span class="tiny muted">(matched by name and state)</span>' : ''}</p>`;
  html += `<h3>Ideology score (DW-NOMINATE)</h3>
    ${ideo.dim1 != null ? `<div class="oddsbar" style="height:12px;position:relative;background:linear-gradient(90deg,var(--dem-soft),var(--soft),var(--rep-soft))" role="img" aria-label="Score ${ideo.dim1.toFixed(3)} on a scale from -1 to +1"><span style="position:absolute;left:calc(${((ideo.dim1 + 1) / 2) * 100}% - 2px);width:4px;height:100%;background:var(--ink)"></span></div>
    <p class="small"><b>${ideo.dim1.toFixed(3)}</b> on a scale from −1 (most liberal) to +1 (most conservative), first dimension, ${ideo.congress}th Congress.${ideo.rank ? ` Ranks ${ideo.rank.rank} of ${ideo.rank.of} in the current ${esc(ideo.chamber)}, from most liberal to most conservative.` : ''}</p>
    <p class="tiny muted">DW-NOMINATE places members by how they vote relative to each other. It describes voting patterns, not a judgement.</p>` : notAvailable('no score computed yet (too few recorded votes)')}`;
  if (v.participation) html += `<h3 style="margin-top:8px">Participation, ${v.participation.congress}th Congress</h3><p class="small">${num(v.participation.cast)} votes cast · ${num(v.participation.missed)} missed${v.participation.rate != null ? ` (${(v.participation.rate * 100).toFixed(1)}%)` : ''}</p>`;
  html += '<h3 style="margin-top:8px">Key votes</h3>';
  if (!v.keyVotesConfigured) html += '<p class="small muted">No key votes selected yet. Which votes count as "key" is an editorial choice, so they are added in Admin, the same list for everyone in a chamber.</p>';
  else if (!v.keyVotes.length) html += '<p class="small muted">None of the selected key votes were held while this person served.</p>';
  else html += `<div class="table-scroll"><table><thead><tr><th>Vote</th><th>Date</th><th>Position</th></tr></thead><tbody>${v.keyVotes.map((k) => `<tr><td>${esc(k.label)} <span class="src">${link(k.source_url)}</span>${k.result ? `<div class="tiny muted">${esc(k.result)}${k.yea != null ? ` (${k.yea}–${k.nay})` : ''}</div>` : ''}</td><td class="num small">${esc(k.date || '')}</td><td><b>${esc(k.position)}</b></td></tr>`).join('')}</tbody></table></div>`;
  return html + `<div class="src" style="margin-top:6px">${link(v.source_url, 'VoteView')} · data ${esc(String(v.fetched_at).slice(0, 10))}</div>`;
}

function personal(d) {
  const x = d.disclosures || {};
  let html = '<header><h2>Personal finances and stock trades</h2></header>';
  const h = x.house;
  if (h?.available) {
    const list = h.filings.slice(0, 8);
    html += `<h3>House Clerk filings</h3>${list.length ? `<p class="small">${h.ptr_count} stock-trade report${h.ptr_count === 1 ? '' : 's'} (Periodic Transaction Reports) filed in ${esc((h.years || []).join(' and '))}.</p>
      <ul class="feed" style="max-height:260px">${list.map((f) => `<li class="small"><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.type_label)}</a> · filed ${esc(f.filed)} <span class="tiny muted">${esc(f.state_district)}</span></li>`).join('')}</ul>
      <p class="tiny muted">House reports are PDFs; open each one for the holdings or trades it lists.</p>` : '<p class="small muted">No House financial disclosure filings found under this name and state for these years.</p>'}
      <div class="src">${link(h.source_url, h.source)} · index ${esc(String(h.fetched_at).slice(0, 10))}</div>`;
  } else if (h) html += `<h3>House Clerk filings</h3>${notAvailable(h.reason)}`;
  const s = x.senate;
  if (s) {
    html += '<h3 style="margin-top:10px">Senate filings (eFD)</h3>';
    if (!s.available) html += notAvailable(s.reason);
    else {
      html += s.reports.length ? `<p class="small">${s.ptr_count} Periodic Transaction Report${s.ptr_count === 1 ? '' : 's'} since 2024.</p><ul class="feed" style="max-height:none">${s.reports.slice(0, 8).map((r) => `<li class="small">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)} · filed ${esc(r.filed)}${r.trades?.length ? trades(r.trades) : r.ptr && r.paper ? ' <span class="tiny muted">(paper filing: open the scan)</span>' : ''}</li>`).join('')}</ul>` : '<p class="small muted">No Senate reports found under this name since 2024.</p>';
      html += `<div class="src">${link(s.source_url, s.source)} · searched ${esc(String(s.fetched_at).slice(0, 10))}${s.stale ? ' <span class="tag stale">Last search failed; showing earlier result</span>' : ''}</div>`;
    }
  }
  return html + '<p class="tiny muted">Disclosures report values in ranges, as filed. Nothing here is estimated.</p>';
}

function trades(rows) {
  return `<div class="table-scroll" style="margin-top:4px"><table><thead><tr><th>Date</th><th>Asset</th><th>Type</th><th>Amount</th><th>Owner</th></tr></thead><tbody>${rows.slice(0, 12).map((t) => `<tr><td class="num">${esc(t.date)}</td><td>${t.ticker ? `<b>${esc(t.ticker)}</b> ` : ''}${esc(t.asset)}</td><td>${esc(t.type)}</td><td class="num">${esc(t.amount)}</td><td>${esc(t.owner)}</td></tr>`).join('')}</tbody></table></div>`;
}
