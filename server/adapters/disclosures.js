// Personal financial disclosures.
// House: the Clerk publishes a yearly ZIP index of every filing (annual reports,
//   candidate reports, and Periodic Transaction Reports = stock trades), with links to PDFs.
//   https://disclosures-clerk.house.gov/FinancialDisclosure
// Senate: eFD (https://efdsearch.senate.gov) has no API; this adapter follows the public
//   search form (agree to terms, then query). Best effort: if the site changes, it reports an error.
import zlib from 'node:zlib';
import { nowIso } from '../lib/util.js';

const HOUSE = process.env.HOUSE_CLERK_BASE || 'https://disclosures-clerk.house.gov/public_disc';
const EFD = process.env.SENATE_EFD_BASE || 'https://efdsearch.senate.gov';

export const HOUSE_TYPES = { P: 'Periodic Transaction Report (trades)', O: 'Annual report', C: 'Candidate report', A: 'Amendment', T: 'Termination report', X: 'Extension request', D: 'Blind trust', W: 'Withdrawal', E: 'Electronic copy', H: 'New member report' };

/** Read every file out of a ZIP buffer (stored or deflated entries). */
export function unzip(buf) {
  // Find the end-of-central-directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + csize);
    files[name] = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Parse the Clerk's yearly XML index. */
export function parseHouseIndex(xml, year) {
  const out = [];
  const tag = (block, t) => (block.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1]?.trim() || '';
  for (const m of xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)) {
    const b = m[1];
    const type = tag(b, 'FilingType');
    const doc = tag(b, 'DocID');
    const y = tag(b, 'Year') || String(year);
    if (!doc) continue;
    out.push({
      last: tag(b, 'Last'), first: tag(b, 'First'), state_district: tag(b, 'StateDst'), type, type_label: HOUSE_TYPES[type] || `Type ${type}`,
      year: Number(y), filed: tag(b, 'FilingDate'), doc_id: doc,
      url: `${HOUSE}/${type === 'P' ? 'ptr-pdfs' : 'financial-pdfs'}/${y}/${doc}.pdf`,
    });
  }
  return out;
}

export function createHouseClerkAdapter({ fetchImpl } = {}) {
  return {
    source: 'U.S. House Clerk',
    async fetchYears(years) {
      const filings = [];
      for (const y of years) {
        const res = await (fetchImpl || fetch)(`${HOUSE}/financial-pdfs/${y}FD.zip`, { headers: { 'User-Agent': 'midterm-live/0.1' } });
        if (res.status === 404) continue; // the new year's file appears after the first filings
        if (!res.ok) throw new Error(`House Clerk HTTP ${res.status} for ${y}FD.zip`);
        const files = unzip(Buffer.from(await res.arrayBuffer()));
        const xmlName = Object.keys(files).find((n) => /\.xml$/i.test(n));
        if (!xmlName) throw new Error(`no XML in ${y}FD.zip`);
        filings.push(...parseHouseIndex(files[xmlName].toString('utf8'), y));
      }
      return { filings, fetched_at: nowIso(), source_url: 'https://disclosures-clerk.house.gov/FinancialDisclosure' };
    },
  };
}

// ---------- Senate eFD ----------
function cookieJar() {
  const jar = new Map();
  return {
    take(res) {
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of list) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    get: (k) => jar.get(k),
    names: () => jar.keys(),
  };
}

const stripTags = (s = '') => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** Parse the transaction table on an eFD Periodic Transaction Report page. */
export function parsePtrTable(html) {
  const body = (html.match(/<tbody>([\s\S]*?)<\/tbody>/i) || [])[1];
  if (!body) return [];
  const rows = [];
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (cells.length < 8) continue;
    // Columns: #, Transaction Date, Owner, Ticker, Asset Name, Asset Type, Type, Amount, (Comment)
    rows.push({ date: cells[1], owner: cells[2], ticker: cells[3] === '--' ? null : cells[3], asset: cells[4], asset_type: cells[5], type: cells[6], amount: cells[7] });
  }
  return rows;
}

export function createSenateEfdAdapter({ fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  async function session() {
    const jar = cookieJar();
    const home = await f(`${EFD}/search/home/`, { headers: { 'User-Agent': 'midterm-live/0.1' } });
    jar.take(home);
    const html = await home.text();
    const token = (html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/) || [])[1];
    if (!token) throw new Error('Senate eFD: could not find the search form token (site may have changed)');
    const agree = await f(`${EFD}/search/home/`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header(), Referer: `${EFD}/search/home/`, 'User-Agent': 'midterm-live/0.1' },
      body: new URLSearchParams({ prohibition_agreement: '1', csrfmiddlewaretoken: token }).toString(),
    });
    jar.take(agree);
    // Follow the redirect (usually to /search/) so any session cookie it sets is kept.
    const loc = agree.headers.get('location');
    if (agree.status >= 300 && agree.status < 400 && loc) {
      const next = await f(new URL(loc, `${EFD}/search/home/`).toString(), { headers: { Cookie: jar.header(), Referer: `${EFD}/search/home/`, 'User-Agent': 'midterm-live/0.1' }, redirect: 'manual' });
      jar.take(next);
    }
    return jar;
  }
  return {
    source: 'U.S. Senate eFD',
    /** Reports filed by people with this last name since startDate (MM/DD/YYYY). */
    async search(lastName, { startDate = '01/01/2024', withTrades = 3 } = {}) {
      const jar = await session();
      const csrf = jar.get('csrftoken') || jar.get('csrf');
      const params = new URLSearchParams({ start: '0', length: '100', report_types: '[7, 11]', filer_types: '[1, 4]', submitted_start_date: `${startDate} 00:00:00`, submitted_end_date: '', candidate_state: '', senator_state: '', office_id: '', first_name: '', last_name: lastName, csrfmiddlewaretoken: csrf || '' });
      const res = await f(`${EFD}/search/report/data/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header(), Referer: `${EFD}/search/`, 'X-CSRFToken': csrf || '', 'User-Agent': 'midterm-live/0.1' }, body: params.toString() });
      if (res.status === 403 && [...jar.names()].some((n) => /^bm_|^ak_|^_abck/.test(n))) throw new Error('the Senate eFD site blocked the automated search (bot protection). Search by hand at https://efdsearch.senate.gov/search/');
      if (!res.ok) throw new Error(`Senate eFD HTTP ${res.status} at search step`);
      const body = await res.json();
      const reports = (body.data || []).map((row) => {
        const link = (row[3] || '').match(/href="([^"]+)"/)?.[1] || null;
        return { first: stripTags(row[0]), last: stripTags(row[1]), filer: stripTags(row[2]), title: stripTags(row[3]), filed: stripTags(row[4]), url: link ? new URL(link, EFD).toString() : null, ptr: /periodic transaction/i.test(row[3] || ''), paper: /\/paper\//.test(link || '') };
      });
      // Pull transaction rows from the most recent electronic trade reports.
      for (const r of reports.filter((x) => x.ptr && x.url && !x.paper).slice(0, withTrades)) {
        try {
          const page = await f(r.url, { headers: { Cookie: jar.header(), 'User-Agent': 'midterm-live/0.1' } });
          if (page.ok) r.trades = parsePtrTable(await page.text());
        } catch {
          /* leave trades undefined: shown as "open the report" */
        }
      }
      return { reports, fetched_at: nowIso(), source_url: `${EFD}/search/` };
    },
  };
}
