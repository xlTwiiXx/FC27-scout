// Holt Preise ALLER Karten ab Rating 75 von FUT.GG (Listen nach Rating, sortiert nach Preis).
// Laeuft komplett kostenlos auf GitHub Actions (Playwright-Browser). Kein Apify.
// Schnelle Ratings (83-99) bei jedem Lauf -> prices.json
// Langsame Ratings (75-82) nur alle N Stunden -> prices-low.json
import fs from 'node:fs';

const range = (a, b) => Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => (a > b ? a - i : a + i));
const cfg = {
  ratings: range(99, 83),
  slowRatings: range(82, 75),
  slowEveryHours: 3,
  pages: 60,
  delayMs: 4000,
  concurrency: 3,
  maxPagesTotal: 500,
  maxMinutes: 50,
  ...JSON.parse(fs.readFileSync('config.json', 'utf8')),
};
const FORCE_ALL = process.env.FORCE_ALL === '1';
const DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DIR, { recursive: true });
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETS = {
  // letzte Tage voll (15-Minuten-Raster), danach stuendlich, danach alle 4 Stunden
  fast: { file: `${DIR}/prices.json`, maxDays: 120 },
  slow: { file: `${DIR}/prices-low.json`, maxDays: 120 },
};
const dbs = {};
for (const [k, s] of Object.entries(SETS)) {
  let d = { updated: null, cards: {} };
  try { d = JSON.parse(fs.readFileSync(s.file, 'utf8')); } catch {}
  d.cards = d.cards || {};
  dbs[k] = d;
}

const num = (s) => {
  const m = String(s).replace(/,/g, '').match(/^([\d.]+)([KM]?)$/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1));
};
const listUrl = (r, p) =>
  `https://www.fut.gg/players/?overall__gte=${r}&overall__lte=${r}&market_players=true&sorts=current_price` +
  (p > 1 ? `&page=${p}` : '');

async function openBrowser() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  return { browser, ctx };
}

function parseLines(lines) {
  const pos = lines.find((l) => /^[A-Z]{2,3}$/.test(l));
  const gi = lines.findIndex((l) => /^\d{2}\.\d$/.test(l));
  if (gi < 0) return null;
  const cand = lines.slice(gi + 1).filter((l) => /^([\d.,]+[KM]?|EXTINCT)$/.test(l));
  if (!cand.length) return null;
  const price = num(cand[cand.length - 1]);
  if (!price) return null;
  return { pos: pos || '?', price };
}

const isBlock = (res) =>
  res.status >= 400 || /just a moment|attention required|access denied|verify you are human/i.test(res.title || '') || (!res.status && !!res.error);

async function directPage(ctx, url) {
  const page = await ctx.newPage();
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    status = resp ? resp.status() : 0;
    // warten, bis Karten da sind ODER die Seite eine leere Liste zeigt
    await page.waitForFunction(
      () => document.querySelector('a[href*="/27-"] img') || /no (players|results)|nothing (found|here)/i.test(document.body.innerText),
      null,
      { timeout: 25000 }
    );
    await page.waitForTimeout(2500);
    const title = await page.title();
    const raw = await page.evaluate(() => {
      const out = [], seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/players/"]')) {
        const m = a.href.match(/\/players\/[^/]+\/27-(\d+)\/?/);
        if (!m || seen.has(m[1])) continue;
        const img = a.querySelector('img');
        const am = (img ? img.alt : '').match(/^(.+?) - (\d{2}) - (.+)$/);
        if (!am) continue;
        seen.add(m[1]);
        out.push({ id: m[1], name: am[1], rating: +am[2], version: am[3], url: a.href,
          im: img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '',
          lines: a.innerText.split('\n').map((s) => s.trim()).filter(Boolean) });
      }
      return out;
    });
    const cards = [];
    for (const c of raw) {
      const x = parseLines(c.lines);
      if (x) cards.push({ id: c.id, name: c.name.trim(), rating: c.rating, version: c.version.trim(), pos: x.pos, price: x.price, url: c.url, im: (c.im.split('futgg-player-item-card/')[1] || '').split('?')[0] });
    }
    return { cards, title, status };
  } catch (e) {
    let title = '';
    try { title = await page.title(); } catch {}
    return { cards: [], error: String(e.message).split('\n')[0], title, status };
  } finally {
    await page.close();
  }
}

const t = Date.now();
const hour = new Date().getUTCHours();
const runSlow = cfg.slowRatings.length > 0 && (FORCE_ALL || hour % (cfg.slowEveryHours || 3) === 0);
// Erstes Erscheinen jeder Karte (fs). 0 = war schon beim allerersten Abruf da (Erscheinungszeit unbekannt)
const popAtStart = Object.values(dbs).reduce((n, d) => n + Object.keys(d.cards).length, 0);
{
  const firsts = [];
  for (const d of Object.values(dbs)) for (const e of Object.values(d.cards)) if (e.h.length) firsts.push(e.h[0][0]);
  firsts.sort((a, b) => a - b);
  const T0 = firsts.length ? firsts[Math.floor(firsts.length * 0.1)] : 0;
  for (const d of Object.values(dbs)) for (const e of Object.values(d.cards)) if (e.fs === undefined) e.fs = T0 && e.h.length && e.h[0][0] > T0 + 6 * 36e5 ? e.h[0][0] : 0;
}
const jobs = [
  ...cfg.ratings.map((r) => ({ r, set: 'fast' })),
  ...(runSlow ? cfg.slowRatings.map((r) => ({ r, set: 'slow' })) : []),
];
console.log(`Start: ${jobs.length} Ratings (${runSlow ? 'inkl.' : 'ohne'} langsame Gruppe), ${cfg.concurrency} parallel.`);

let b;
try { b = await openBrowser(); }
catch (e) { console.error('Browser nicht verfuegbar:', e.message); process.exit(1); }

let pages = 0, total = 0, blocked = false, hardBlocks = 0;
const touched = new Set();

// ---------- Manuelle Preispunkte (manual.json) ----------
// Format: [{ "name": "Rodri", "rating": 90, "points": [["2026-10-09 12:00", 28000], ...] }]  (Uhrzeiten = deutsche Zeit)
const berlinOffsetMin = (t) => {
  const v = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' }).formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName').value;
  const m = v.match(/GMT([+-]\d+)(?::(\d+))?/);
  return m ? +m[1] * 60 + (m[2] ? Math.sign(+m[1]) * +m[2] : 0) : 0;
};
const berlinToUtc = (str) => {
  const m = String(str).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return NaN;
  const [y, mo, d, h, mi] = m.slice(1).map(Number), base = Date.UTC(y, mo - 1, d, h, mi);
  let t = base - berlinOffsetMin(base) * 60000;
  t = base - berlinOffsetMin(t) * 60000;
  return t;
};
const nrm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function applyManual() {
  let list;
  try { list = JSON.parse(fs.readFileSync('manual.json', 'utf8')); } catch { return; }
  for (const m of Array.isArray(list) ? list : []) {
    let found = null, foundSet = null;
    for (const [k, db] of Object.entries(dbs)) {
      for (const e of Object.values(db.cards)) {
        if (nrm(e.name) !== nrm(m.name)) continue;
        if (m.rating && e.rating !== +m.rating) continue;
        if (m.version && nrm(e.version) !== nrm(m.version)) continue;
        if (!found || (e.h.length && found.h.length && e.h[e.h.length - 1][1] < found.h[found.h.length - 1][1])) { found = e; foundSet = k; }
      }
    }
    if (!found) { console.log(`Manuell: Karte "${m.name}" ${m.rating || ''} nicht gefunden (steht sie schon in den Preislisten?)`); continue; }
    const have = new Set(found.h.map((x) => x[0]));
    let add = 0;
    for (const [ts, p] of m.points || []) {
      const t = berlinToUtc(ts);
      if (t > 0 && p > 0 && !have.has(t)) { found.h.push([t, Math.round(p)]); have.add(t); add++; }
    }
    found.h.sort((a, b) => a[0] - b[0]);
    if (add) touched.add(foundSet);
    console.log(`Manuell: ${found.name} ${found.rating}: ${add} neue Punkte`);
  }
}
const stop = () => blocked || pages >= cfg.maxPagesTotal || (Date.now() - startedAt) / 60000 > cfg.maxMinutes;

async function runJob(job) {
  const db = dbs[job.set];
  const seen = new Set();
  for (let p = 1; p <= cfg.pages; p++) {
    if (stop()) { console.log(`Rating ${job.r}: Limit erreicht, Rest folgt im naechsten Lauf.`); return; }
    let res = await directPage(b.ctx, listUrl(job.r, p)); pages++;
    if (!res.cards.length && p === 1 && isBlock(res)) {
      await sleep(6000);
      res = await directPage(b.ctx, listUrl(job.r, p)); pages++;
    }
    const cards = res.cards;
    if (!cards.length && p === 1) {
      if (isBlock(res)) {
        hardBlocks++;
        console.error(`Rating ${job.r}: blockiert (Status ${res.status || '-'}, ${res.title || res.error || '-'})`);
        if (hardBlocks >= 3) blocked = true;
      } else {
        console.log(`Rating ${job.r}: keine Karten auf dem Markt, uebersprungen.`);
      }
      return;
    }
    if (!cards.length) return; // Ende der Liste
    const fresh = cards.filter((c) => !seen.has(c.id));
    if (!fresh.length) return;
    for (const c of fresh) {
      seen.add(c.id);
      const e = db.cards[c.id] || { h: [], fs: popAtStart >= 200 ? t : 0 };
      Object.assign(e, { name: c.name, rating: c.rating, version: c.version, pos: c.pos, url: c.url });
      if (c.im) e.im = c.im;
      e.h.push([t, c.price]);
      db.cards[c.id] = e;
    }
    touched.add(job.set);
    total += fresh.length;
    console.log(`Rating ${job.r} Seite ${p}: ${fresh.length} Karten`);
    await sleep(cfg.delayMs + Math.random() * 2000);
  }
}

const queue = [...jobs];
await Promise.all(
  Array.from({ length: Math.max(1, cfg.concurrency) }, async () => {
    while (queue.length && !stop()) await runJob(queue.shift());
  })
);
await b.browser.close();
applyManual();
if (total === 0) { console.error('Keine Daten erhalten, Dateien bleiben unveraendert.'); process.exit(1); }

// Deutscher Kalendertag eines Zeitpunkts (Tage seit 1970 nach deutscher Zeit)
const offCache = new Map();
const offAt = (x) => { const k = Math.floor(x / 36e5); let v = offCache.get(k); if (v === undefined) { v = berlinOffsetMin(x); offCache.set(k, v); } return v; };
const dayKey = (x) => Math.floor((x + offAt(x) * 6e4) / 864e5);
const hourKey = (x) => Math.floor((x + offAt(x) * 6e4) / 36e5);
// Heute: letzter Punkt jeder vollen Stunde plus Tagestief und Tageshoch. Vergangene Tage: nur Tief und Hoch (jeweils mit Uhrzeit).
function condense(h, nowT) {
  const today = dayKey(nowT), days = new Map();
  for (const x of h) { const d = dayKey(x[0]); if (!days.has(d)) days.set(d, []); days.get(d).push(x); }
  const out = [];
  for (const [d, pts] of days) {
    let mn = pts[0], mx = pts[0];
    for (const x of pts) { if (x[1] < mn[1]) mn = x; if (x[1] > mx[1]) mx = x; }
    if (d === today) {
      const keep = new Map(), byHour = new Map();
      for (const x of pts) byHour.set(hourKey(x[0]), x);
      for (const x of byHour.values()) keep.set(x[0], x);
      keep.set(mn[0], mn); keep.set(mx[0], mx);
      out.push(...keep.values());
    } else {
      out.push(mn);
      if (mx !== mn) out.push(mx);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

for (const set of touched) {
  const s = SETS[set], db = dbs[set];
  const cutoff = t - s.maxDays * 864e5;
  for (const [id, e] of Object.entries(db.cards)) {
    e.h.sort((x, y) => x[0] - y[0]);
    e.h = condense(e.h.filter((x) => x[0] >= cutoff), t);
    if (!e.h.length) delete db.cards[id];
  }
  db.updated = new Date(t).toISOString();
  db.meta = { cards: Object.keys(db.cards).length };
  fs.writeFileSync(s.file, JSON.stringify(db));
}
console.log(`Fertig: ${total} Preise, ${pages} Seiten, ${Math.round((Date.now() - startedAt) / 60000)} Min.`);
