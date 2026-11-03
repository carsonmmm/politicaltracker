import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Engine, RATINGS } from './engine.js';
import { startScheduler } from './scheduler.js';
import { probeAll } from './probe.js';
import { ROOT, nowIso } from './lib/util.js';
import { STATUSES } from './adapters/results.js';
import { partyFromLabel } from './lib/match.js';
import { store } from './store.js';
import { validateProfile, validateMoment, candidateKey, ISSUES, MOMENT_TYPES } from './profiles.js';
import { validateMeasure, measureId } from './measures.js';

const PORT = Number(process.env.PORT || 8080);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(9).toString('base64url');

const engine = new Engine();
let lastProbe = store.load('probe.json', null);

const STATIC = {
  '/vendor/topojson-client.min.js': path.join(ROOT, 'node_modules/topojson-client/dist/topojson-client.min.js'),
  '/geo/states.json': path.join(ROOT, 'node_modules/us-atlas/states-albers-10m.json'),
  '/geo/counties.json': path.join(ROOT, 'node_modules/us-atlas/counties-albers-10m.json'),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(code, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 2_000_000) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}

function serveFile(res, file, cache = 'no-cache') {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}

const sseClients = new Set();
engine.onChange(({ version, reason }) => {
  for (const res of sseClients) res.write(`event: update\ndata: ${JSON.stringify({ version, reason })}\n\n`);
});
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25_000);

// ---------- admin helpers ----------
function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const err400 = (msg) => Object.assign(new Error(msg), { code: 400 });
const need = (cond, msg) => {
  if (!cond) throw err400(msg);
};
const isUrl = (u) => /^https?:\/\/\S+$/.test(u || '');

const admin = {
  result(b) {
    need(engine.byId.has(b.raceId), 'Unknown raceId');
    need(STATUSES.includes(b.status), `status must be one of ${STATUSES.join(', ')}`);
    need(Array.isArray(b.candidates) && b.candidates.every((c) => c.name && Number.isFinite(Number(c.votes ?? 0))), 'candidates: [{name, party, votes}]');
    need(b.source && isUrl(b.source_url), 'A result needs where it came from: source and source_url');
    let call = null;
    if (b.status === 'called') {
      need(b.call?.winner && b.call?.calledBy, 'A call needs the winner and the outlet that called it (AP, Decision Desk HQ, or a network decision desk)');
      call = { winner: b.call.winner, party: b.call.party || b.candidates.find((c) => c.name === b.call.winner)?.party || null, calledBy: b.call.calledBy, calledAt: b.call.calledAt || nowIso(), source_url: b.call.source_url || b.source_url };
    }
    engine.manual.results[b.raceId] = {
      raceId: b.raceId,
      source: 'Manual',
      manual: true,
      manual_source: b.source,
      source_url: b.source_url,
      fetched_at: nowIso(),
      kind: b.kind === 'certified' ? 'certified' : 'unofficial',
      status: b.status,
      pctExpected: b.pctExpected === '' || b.pctExpected == null ? null : Number(b.pctExpected),
      call,
      candidates: b.candidates.map((c) => ({ name: c.name, party: c.party || partyFromLabel(c.name) || 'O', votes: Number(c.votes || 0), incumbent: Boolean(c.incumbent) })),
      counties: [],
      rcvRounds: Array.isArray(b.rcvRounds) ? b.rcvRounds : [],
      outstanding_note: b.outstanding_note || null,
    };
  },
  candidate(b) {
    need(engine.byId.has(b.raceId), 'Unknown raceId');
    need(b.name && ['D', 'R', 'O', 'I', 'L', 'G'].includes(b.party), 'name and party (D, R, I, L, G, O) required');
    need(isUrl(b.source_url), 'source_url required');
    const list = (engine.manual.candidates[b.raceId] ||= []);
    const row = { name: b.name, party: b.party === 'I' || b.party === 'L' || b.party === 'G' ? 'O' : b.party, party_label: b.party, incumbent: Boolean(b.incumbent), source: b.source || 'Manual', source_url: b.source_url, entered_at: nowIso() };
    const i = list.findIndex((c) => c.name.toLowerCase() === b.name.toLowerCase());
    if (i >= 0) list[i] = row;
    else list.push(row);
  },
  rating(b) {
    need(engine.byId.has(b.raceId), 'Unknown raceId');
    need(RATINGS.includes(b.rating), `rating must be one of ${RATINGS.join(', ')}`);
    need(b.outlet && /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') && isUrl(b.source_url), 'outlet, date (YYYY-MM-DD) and source_url required');
    engine.manual.ratings.push({ raceId: b.raceId, outlet: b.outlet, rating: b.rating, date: b.date, source_url: b.source_url, entered_at: nowIso() });
  },
  poll(b) {
    need(engine.byId.has(b.raceId), 'Unknown raceId');
    need(b.average && /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') && isUrl(b.source_url) && Array.isArray(b.values), 'average (whose average), date, source_url and values [{name, pct}] required');
    engine.manual.polls.push({ raceId: b.raceId, average: b.average, date: b.date, source_url: b.source_url, values: b.values.map((v) => ({ name: v.name, pct: Number(v.pct) })), entered_at: nowIso() });
  },
  note(b) {
    need(engine.byId.has(b.raceId), 'Unknown raceId');
    engine.manual.notes[b.raceId] = b.text ? { text: String(b.text).slice(0, 2000), source_url: b.source_url || null, entered_at: nowIso() } : undefined;
  },
  'market-map'(b) {
    need(/^(kalshi|polymarket):/.test(b.key || ''), 'key like kalshi:<event_ticker> or polymarket:<slug>');
    need(b.raceId === null || engine.byId.has(b.raceId) || /^CONTROL-(S|H)$/.test(b.raceId), 'raceId must be a race, CONTROL-S, CONTROL-H, or null to ignore');
    engine.manual.marketMap[b.key] = b.raceId;
  },
  chamber(b) {
    need(b.senate && b.house && b.governors, 'senate, house and governors required');
    engine.manual.chamber = { ...b, verified: Boolean(b.verified), source: b.source || 'Manual', entered_at: nowIso() };
  },
  'poll-closing'(b) {
    need(b.state && /^\d{2}:\d{2}(\+1)?$/.test(b.first || '') && /^\d{2}:\d{2}(\+1)?$/.test(b.last || ''), 'state, first, last (HH:MM ET, +1 for next day)');
    engine.manual.pollClosing ||= { states: {} };
    engine.manual.pollClosing.states[b.state] = { first: b.first, last: b.last, source_url: b.source_url || null, manual: true };
  },
  profile(b) {
    need(engine.byId.has(b.raceId), 'Unknown raceId');
    need(b.name, 'name required');
    need(!b.fec_id || /^[HS]\d[A-Z]{2}\d{5}$/.test(b.fec_id), 'fec_id looks like H6GA07123 or S6GA00123');
    need(!b.bioguide_id || /^[A-Z]\d{6}$/.test(b.bioguide_id), 'bioguide_id looks like O000174');
    const problems = validateProfile(b);
    need(!problems.length, problems.join('; '));
    const { raceId, name } = b;
    const clean = { raceId, name, fec_id: b.fec_id || undefined, bioguide_id: b.bioguide_id || undefined, bio: b.bio, offices: b.offices, elections: b.elections, roles: b.roles, endorsements: b.endorsements, positions: b.positions, entered_at: nowIso() };
    engine.manual.profiles[candidateKey(raceId, name)] = JSON.parse(JSON.stringify(clean));
  },
  lean(b) {
    need(engine.byId.has(b.raceId), 'Unknown raceId');
    need(/^(D|R)\+\d{1,2}$|^EVEN$/.test(b.value || ''), 'value like R+5, D+3 or EVEN');
    need(b.source && isUrl(b.source_url) && /^\d{4}(-\d{2}-\d{2})?$/.test(b.date || ''), 'source (e.g. Cook PVI 2025), source_url and date (YYYY or YYYY-MM-DD) required');
    engine.manual.lean = engine.manual.lean.filter((l) => !(l.raceId === b.raceId && l.source === b.source));
    engine.manual.lean.push({ raceId: b.raceId, value: b.value, source: b.source, date: b.date, source_url: b.source_url, entered_at: nowIso() });
  },
  'key-vote'(b) {
    need(['Senate', 'House'].includes(b.chamber), 'chamber is Senate or House');
    need(Number.isInteger(Number(b.congress)) && Number.isInteger(Number(b.rollnumber)), 'congress and rollnumber must be numbers (VoteView roll-call number)');
    need(b.label && isUrl(b.source_url), 'label and source_url required');
    engine.manual.keyVotes = engine.manual.keyVotes.filter((k) => !(k.chamber === b.chamber && Number(k.congress) === Number(b.congress) && Number(k.rollnumber) === Number(b.rollnumber)));
    engine.manual.keyVotes.push({ chamber: b.chamber, congress: Number(b.congress), rollnumber: Number(b.rollnumber), label: String(b.label).slice(0, 200), source_url: b.source_url, entered_at: nowIso() });
    engine.voteviewStale = true; // refetch casts for the new vote
  },
  measure(b) {
    const problems = validateMeasure(b);
    need(!problems.length, problems.join('; '));
    const id = measureId(b.state, b.number);
    engine.manual.measures[id] = { state: b.state, number: b.number, title: b.title, summary: b.summary || undefined, summary_source_url: b.summary_source_url || undefined, threshold: b.threshold || 'majority', supporters: b.supporters || [], opponents: b.opponents || [], finance: b.finance || {}, ap_race_id: b.ap_race_id || undefined, entered_at: nowIso() };
    engine.syncMeasures();
  },
  runoff(b) {
    need(engine.byId.has(b.raceId), 'Unknown raceId');
    need(/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') && isUrl(b.source_url), 'date (YYYY-MM-DD) and source_url required');
    engine.manual.runoffs[b.raceId] = { date: b.date, source_url: b.source_url, origin: 'Manual', entered_at: nowIso() };
  },
  recount(b) {
    need(/^[A-Z]{2}$/.test(b.state || ''), 'state (two letters) required');
    need(['automatic', 'request'].includes(b.type), 'type is automatic or request');
    need(b.margin_pct != null || b.margin_votes != null, 'margin_pct or margin_votes required');
    need(isUrl(b.source_url), 'source_url required');
    engine.manual.recount[b.state] = { type: b.type, margin_pct: b.margin_pct == null || b.margin_pct === '' ? undefined : Number(b.margin_pct), margin_votes: b.margin_votes == null || b.margin_votes === '' ? undefined : Number(b.margin_votes), note: b.note || undefined, source_url: b.source_url, verified: true, entered_at: nowIso() };
  },
  certification(b) {
    need(/^[A-Z]{2}$/.test(b.state || ''), 'state (two letters) required');
    need(/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') && isUrl(b.source_url), 'date (YYYY-MM-DD) and source_url required');
    engine.manual.certification[b.state] = { date: b.date, body: b.body || undefined, source_url: b.source_url, entered_at: nowIso() };
  },
  moment(b) {
    const problems = validateMoment(b);
    need(!problems.length, problems.join('; '));
    need(engine.byId.has(b.raceId), 'Unknown raceId');
    engine.manual.moments.push({ raceId: b.raceId, date: b.date, type: b.type, text: String(b.text).slice(0, 500), source_url: b.source_url, entered_at: nowIso() });
  },
  delete(b) {
    const { kind, raceId, index } = b;
    if (kind === 'profile') delete engine.manual.profiles[b.key];
    else if (kind === 'runoff') delete engine.manual.runoffs[raceId];
    else if (kind === 'recount') delete engine.manual.recount[raceId];
    else if (kind === 'certification') delete engine.manual.certification[raceId];
    else if (kind === 'measure') { delete engine.manual.measures[raceId]; engine.syncMeasures(); }
    else if (kind === 'lean') {
      const own = engine.manual.lean.map((r, i) => [r, i]).filter(([r]) => r.raceId === raceId);
      if (own[index]) engine.manual.lean.splice(own[index][1], 1);
    }
    else if (kind === 'key-vote') { engine.manual.keyVotes.splice(index, 1); engine.voteviewStale = true; }
    else if (kind === 'moment') {
      const own = engine.manual.moments.map((r, i) => [r, i]).filter(([r]) => r.raceId === raceId);
      if (own[index]) engine.manual.moments.splice(own[index][1], 1);
    } else if (kind === 'result') delete engine.manual.results[raceId];
    else if (kind === 'candidate') engine.manual.candidates[raceId]?.splice(index, 1);
    else if (kind === 'rating' || kind === 'poll') {
      const arr = engine.manual[kind === 'rating' ? 'ratings' : 'polls'];
      const own = arr.map((r, i) => [r, i]).filter(([r]) => r.raceId === raceId);
      if (own[index]) arr.splice(own[index][1], 1);
    } else throw err400('unknown kind');
  },
};

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true, version: engine.version, uptime_s: Math.round(process.uptime()) });
    if (p === '/api/state') return send(res, 200, engine.state());
    if (p.startsWith('/api/race/')) {
      const rid = decodeURIComponent(p.slice(10));
      const race = engine.byId.get(rid);
      if (race && (race.office === 'S' || race.office === 'H') && !engine.finance[rid]) engine.financeRequests.add(rid);
      const d = engine.raceDetail(rid);
      return d ? send(res, 200, d) : send(res, 404, { error: 'unknown race' });
    }
    if (p.startsWith('/api/candidate/')) {
      const [rid, slug] = p.slice(15).split('/').map(decodeURIComponent);
      const d = engine.candidateDetail(rid, slug);
      return d ? send(res, 200, d) : send(res, 404, { error: 'unknown candidate' });
    }
    if (p === '/api/meta') return send(res, 200, { issues: ISSUES, momentTypes: MOMENT_TYPES });
    if (p === '/api/control') {
      return send(res, 200, { 'CONTROL-S': { ...engine.oddsView('CONTROL-S'), history: engine.oddsHistory.get('CONTROL-S') || [] }, 'CONTROL-H': { ...engine.oddsView('CONTROL-H'), history: engine.oddsHistory.get('CONTROL-H') || [] } });
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ version: engine.version })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/sources') return send(res, 200, { probe: lastProbe, feeds: engine.feeds });
    if (p === '/api/probe' && req.method === 'POST') {
      lastProbe = { ran_at: nowIso(), rows: await probeAll() };
      store.save('probe.json', lastProbe);
      return send(res, 200, lastProbe);
    }
    if (p.startsWith('/api/admin/')) {
      if (!tokenOk(req.headers['x-admin-token'])) return send(res, 401, { error: 'Admin token required' });
      const action = p.slice(11);
      if (action === 'check') return send(res, 200, { ok: true });
      if (action === 'manual') return send(res, 200, engine.manual);
      if (action === 'unmatched') return send(res, 200, engine.unmatched);
      if (req.method !== 'POST' || !admin[action]) return send(res, 404, { error: 'unknown admin action' });
      const body = await readBody(req);
      admin[action](body);
      engine.saveManual();
      return send(res, 200, { ok: true });
    }
    if (STATIC[p]) return serveFile(res, STATIC[p], 'public, max-age=86400');
    const file = path.join(ROOT, 'public', p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(path.join(ROOT, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);
    return send(res, 404, 'Not found');
  } catch (err) {
    const bad = err.code === 400 || err instanceof SyntaxError; // SyntaxError = malformed JSON body
    return send(res, bad ? 400 : 500, { error: err instanceof SyntaxError ? 'Request body is not valid JSON' : err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Midterm Live on http://localhost:${PORT}`);
  // Never print a token the operator chose (hosting logs are often shared); only show a generated one.
  console.log(process.env.ADMIN_TOKEN ? 'Admin token: set from ADMIN_TOKEN (not printed)' : `Admin token: ${ADMIN_TOKEN} (random for this run; set ADMIN_TOKEN to choose your own)`);
  if (!process.env.NO_POLL) startScheduler(engine);
  probeAll().then((rows) => {
    lastProbe = { ran_at: nowIso(), rows };
    store.save('probe.json', lastProbe);
    for (const r of rows) console.log(`  [probe] ${r.result.padEnd(11)} ${r.name}`);
  });
});
