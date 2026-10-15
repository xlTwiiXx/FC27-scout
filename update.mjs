// Holt Preise ALLER Karten ab Rating 75 von FUT.GG (Listen nach Rating, sortiert nach Preis).
// Schnelle Ratings (z. B. 83-99) bei jedem Lauf -> prices.json
// Langsame Ratings (z. B. 75-82) nur alle N Stunden -> prices-low.json
// mode "direct": nur kostenlos per Browser auf GitHub. "auto": bei Sperre Ersatz ueber Apify (kostet!).
import fs from 'node:fs';

const range = (a, b) => Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => (a > b ? a - i : a + i));
const cfg = {
  ratings: range(99, 83),
  slowRatings: range(82, 75),
  slowEveryHours: 3,
  pages: 60,               // max. Seiten je Rating (Job stoppt selbst am Listenende)
  mode: 'direct',
  delayMs: 4000,           // Pause je Seite und Worker
  concurrency: 3,          // gleichzeitige Browser-Seiten
  maxPagesTotal: 500,
  maxMinutes: 50,
  apifyPagesPerRating: 1,
  ...JSON.parse(fs.readFileSync('config.json', 'utf8')),
};
const TOKEN = process.env.APIFY_TOKEN || '';
const FORCE_ALL = process.env.FORCE_ALL === '1';
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETS = {
  fast: { file: 'prices.json', fullDays: 3, thinHours: 3, maxDays: 14 },
  slow: { file: 'prices-low.json', fullDays: 2, thinHours: 3, maxDays: 7 },
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

// ---------- Direkt per Browser (Playwright) ----------
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

async function directPage(ctx, url) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="/27-"] img', { timeout: 25000 });
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
          lines: a.innerText.split('\n').map((s) => s.trim()).filter(Boolean) });
      }
      return out;
    });
    const cards = [];
    for (const c of raw) {
      const x = parseLines(c.lines);
      if (x) cards.push({ id: c.id, name: c.name.trim(), rating: c.rating, version: c.version.trim(), pos: x.pos, price: x.price, url: c.url });
    }
    return { cards, title };
  } catch (e) {
    return { cards: [], error: String(e.message).split('\n')[0] };
  } finally {
    await page.close();
  }
}

// ---------- Ersatzweg: Apify (nur mode "auto") ----------
const RE = /\[\s*!\[(.+?) - (\d{2}) - (.+?)\]\([^)]*\)\s*([A-Z]{2,3})\s*([\d.]+)\s*!\[Coin\]\([^)]*\)\s*([\d.,]+[KM]?|EXTINCT)[\s\S]*?\]\((https:\/\/www\.fut\.gg\/players\/[^)\s]+\/27-(\d+)\/)\)/g;
async function apifyPage(url) {
  if (!TOKEN) { console.error('APIFY_TOKEN fehlt, Ersatzweg nicht moeglich.'); return []; }
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(
        'https://api.apify.com/v2/acts/apify~rag-web-browser/run-sync-get-dataset-items?timeout=180&memory=4096',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
          body: JSON.stringify({ query: url, maxResults: 1, outputFormats: ['markdown'], scrapingTool: 'browser-playwright', dynamicContentWaitSecs: 10 }),
          signal: AbortSignal.timeout(240000),
        }
      );
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const items = await r.json();
      const md = (items && items[0] && items[0].markdown) || '';
      const out = [];
      RE.lastIndex = 0;
      let m;
      while ((m = RE.exec(md))) {
        const price = num(m[6]);
        if (price) out.push({ id: m[8], name: m[1].trim(), rating: +m[2], version: m[3].trim(), pos: m[4], price, url: m[7] });
      }
      return out;
    } catch (e) {
      console.error('Apify-Versuch ' + (i + 1) + ' fehlgeschlagen:', e.message);
    }
  }
  return [];
}

// ---------- Hauptablauf ----------
const t = Date.now();
const hour = new Date().getUTCHours();
const runSlow = cfg.slowRatings.length > 0 && (FORCE_ALL || hour % (cfg.slowEveryHours || 3) === 0);
const jobs = [
  ...cfg.ratings.map((r) => ({ r, set: 'fast' })),
  ...(runSlow ? cfg.slowRatings.map((r) => ({ r, set: 'slow' })) : []),
];
console.log(`Start: ${jobs.length} Ratings (${runSlow ? 'inkl.' : 'ohne'} langsame Gruppe), Modus ${cfg.mode}, ${cfg.concurrency} parallel.`);

let direct = cfg.mode !== 'apify';
let b = null;
if (direct) {
  try { b = await openBrowser(); }
  catch (e) { console.error('Browser nicht verfuegbar:', e.message); direct = false; }
}
if (!direct && cfg.mode === 'direct') { console.error('Direktmodus nicht moeglich.'); process.exit(1); }

let pages = 0, total = 0, nDirect = 0, nApify = 0, blocked = false;
const touched = new Set();
const stop = () => blocked || pages >= cfg.maxPagesTotal || (Date.now() - startedAt) / 60000 > cfg.maxMinutes;

async function runJob(job) {
  const db = dbs[job.set];
  const seen = new Set();
  for (let p = 1; p <= cfg.pages; p++) {
    if (stop()) { console.log(`Rating ${job.r}: Limit erreicht, Rest folgt im naechsten Lauf.`); return; }
    let cards = [];

    if (direct) {
      let res = await directPage(b.ctx, listUrl(job.r, p)); pages++;
      if (!res.cards.length && p === 1) {
        await sleep(6000);
        res = await directPage(b.ctx, listUrl(job.r, p)); pages++;
      }
      cards = res.cards;
      if (!cards.length && p === 1) {
        console.error(`Rating ${job.r}: leer oder blockiert (${res.error || res.title || '-'})`);
        if (cfg.mode === 'direct') { blocked = true; return; }
        direct = false;
        console.log('Wechsle zu Apify (Ersatzweg).');
      } else if (!cards.length) {
        return; // Ende der Liste
      } else {
        nDirect++;
      }
    }

    if (!direct) {
      if (p > cfg.apifyPagesPerRating) return;
      cards = await apifyPage(listUrl(job.r, p)); pages++;
      if (cards.length < 5) { console.error(`Apify lieferte zu wenig (Rating ${job.r}).`); return; }
      nApify++;
    }

    const fresh = cards.filter((c) => !seen.has(c.id));
    if (!fresh.length) return;
    for (const c of fresh) {
      seen.add(c.id);
      const e = db.cards[c.id] || { h: [] };
      Object.assign(e, { name: c.name, rating: c.rating, version: c.version, pos: c.pos, url: c.url });
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

if (b) await b.browser.close();
if (total === 0) { console.error('Keine Daten erhalten, Dateien bleiben unveraendert.'); process.exit(1); }

for (const set of touched) {
  const s = SETS[set], db = dbs[set];
  const cutoff = t - s.maxDays * 864e5;
  for (const [id, e] of Object.entries(db.cards)) {
    let last = 0;
    e.h = e.h.filter((x) => {
      if (x[0] < cutoff) return false;
      if (x[0] >= t - s.fullDays * 864e5) { last = x[0]; return true; }
      if (x[0] - last >= s.thinHours * 36e5) { last = x[0]; return true; }
      return false;
    });
    if (!e.h.length) delete db.cards[id];
  }
  db.updated = new Date(t).toISOString();
  db.meta = { cards: Object.keys(db.cards).length, mode: cfg.mode };
  fs.writeFileSync(s.file, JSON.stringify(db));
}
console.log(`Fertig: ${total} Preise, ${pages} Seiten (${nDirect} direkt, ${nApify} Apify), ${Math.round((Date.now() - startedAt) / 60000)} Min.`);
