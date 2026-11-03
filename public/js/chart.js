// Minimal SVG line chart. series: [{label, color, points:[{t: iso, p: 0..1}]}]
import { esc } from './ui.js';

export function lineChart(series, { height = 200, width = 640, yMax = 1, yFmt = (v) => `${Math.round(v * 100)}%`, title = 'Chart' } = {}) {
  const pts = series.flatMap((s) => s.points);
  if (pts.length < 2) return '<p class="empty">Not enough history yet to draw a trend line.</p>';
  const pad = { l: 36, r: 10, t: 10, b: 22 };
  const t0 = Math.min(...pts.map((p) => Date.parse(p.t)));
  const t1 = Math.max(...pts.map((p) => Date.parse(p.t)));
  const span = Math.max(1, t1 - t0);
  const x = (t) => pad.l + ((Date.parse(t) - t0) / span) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / yMax) * (height - pad.t - pad.b);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = f * yMax;
    return `<line class="ax" x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 4}" y="${y(v) + 3}" text-anchor="end">${esc(yFmt(v))}</text>`;
  }).join('');
  const fmtT = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(span < 2 * 86400000 ? { hour: 'numeric' } : {}) , timeZone: 'America/New_York' });
  const xt = [0, 0.5, 1].map((f) => `<text x="${pad.l + f * (width - pad.l - pad.r)}" y="${height - 6}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${esc(fmtT(t0 + f * span))}</text>`).join('');
  const lines = series
    .filter((s) => s.points.length)
    .map((s) => {
      const sorted = [...s.points].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      const d = sorted.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join('');
      const last = sorted.at(-1);
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 3"' : ''}/><circle cx="${x(last.t)}" cy="${y(last.p)}" r="3" fill="${s.color}"/>`;
    })
    .join('');
  const legend = series.filter((s) => s.points.length).map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${grid}${xt}${lines}</svg><div class="legend">${legend}</div></div>`;
}
