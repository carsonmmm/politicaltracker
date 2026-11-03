export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const PARTY_NAME = { D: 'Democrat', R: 'Republican', O: 'Other' };
export const PARTY_SHORT = { D: 'D', R: 'R', O: 'Ind/Oth' };
export const OFFICE_NAME = { S: 'Senate', G: 'Governor', H: 'House' };
export const STATUS_LABEL = {
  not_reporting: 'Not yet reporting',
  counting: 'Counting — not called',
  too_early: 'Too early to call',
  too_close: 'Too close to call',
  called: 'Called',
  recount: 'Recount',
  runoff: 'Runoff',
};

export const pct = (p, digits = 0) => (p === null || p === undefined ? '—' : `${(p * 100).toFixed(digits)}%`);
export const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
export const money = (n) => (n === null || n === undefined ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
export const compact = (n) => (n === null || n === undefined ? '—' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n));

export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export const timeET = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET' : '—');
export const dateTimeET = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET' : '—');

/** Source attribution line: "Kalshi · 2 min ago" with link, and a STALE tag if needed. */
export function src({ source, source_url, fetched_at, stale, manual, extra = '' }) {
  const name = source_url ? `<a href="${esc(source_url)}" target="_blank" rel="noopener">${esc(source)}</a>` : esc(source);
  return `<span class="src">${name} · <time datetime="${esc(fetched_at)}" title="${esc(dateTimeET(fetched_at))}">updated ${esc(ago(fetched_at))}</time>${stale ? ' <span class="tag stale">Stale</span>' : ''}${manual ? ' <span class="tag manual">Manual</span>' : ''}${extra}</span>`;
}

export const chip = (party) => `<span class="chip ${esc(party || 'O')}" aria-label="${esc(PARTY_NAME[party] || 'Other')}">${esc(party === 'O' || !party ? 'I/O' : party)}</span>`;

export function statusTag(s) {
  const label = STATUS_LABEL[s.status] || s.status;
  if (s.status === 'called' && s.call) return `<span class="tag called">Called · ${esc(s.call.calledBy)}</span>`;
  const cls = s.status === 'too_close' || s.status === 'recount' || s.status === 'runoff' ? 'warn' : '';
  return `<span class="tag ${cls}">${esc(label)}</span>`;
}

/** "Leading" text that never says "won". */
export function leadText(s) {
  if (s.status === 'called' && s.call) return `${chip(s.call.party)} <strong>${esc(s.call.winner)}</strong> — winner, called by ${esc(s.call.calledBy)}`;
  if (s.leader) return `${chip(s.leader.party)} ${esc(s.leader.name)} leading${s.marginPct !== null ? ` by ${s.marginPct.toFixed(1)} pts` : ''}`;
  return '<span class="muted">No votes reported</span>';
}

export function oddsBar(odds) {
  const D = odds.D ?? 0, R = odds.R ?? 0, O = odds.O ?? 0;
  if (!D && !R && !O) return '<div class="oddsbar" aria-hidden="true"></div>';
  const tot = Math.max(1, D + R + O);
  return `<div class="oddsbar" role="img" aria-label="Market-implied: D ${pct(odds.D)}, R ${pct(odds.R)}"><span class="D" style="width:${(D / tot) * 100}%"></span><span class="O" style="width:${(O / tot) * 100}%"></span><span class="R" style="width:${(R / tot) * 100}%"></span></div>`;
}

export function oddsText(odds) {
  const parts = ['D', 'R', 'O'].filter((p) => odds[p] !== undefined).map((p) => `<span class="p${p}"><b>${p === 'O' ? 'Oth' : p}</b> ${pct(odds[p])}</span>`);
  return parts.length ? parts.join(' · ') : '<span class="muted">No market found</span>';
}

export const raceLink = (s) => `#/race/${encodeURIComponent(s.id)}`;

export function notAvailable(reason) {
  return `<p class="empty">Not available — ${esc(reason)}</p>`;
}

/** Replace the contents of [data-k] sections only when their HTML changed, so the page does not jump. */
export function patch(root, sections, force = false) {
  for (const [k, html] of Object.entries(sections)) {
    const el = root.querySelector(`[data-k="${k}"]`);
    if (!el) continue;
    if (!force && el._html === html) continue;
    el._html = html;
    el.innerHTML = html;
  }
}
