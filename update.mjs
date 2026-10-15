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
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETS = {
  fast: { file: 'prices.json', fullDays: 3, thinHours: 4, maxDays: 40 },
  slow: { file: 'prices-low.json', fullDays: 2, thinHours: 4, maxDays: 14 },
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
          lines: a.innerText.split('\n').map((s) => s.trim()).filter(Boolean) });
      }
      return out;
    });
    const cards = [];
    for (const c of raw) {
      const x = parseLines(c.lines);
      if (x) cards.push({ id: c.id, name: c.name.trim(), rating: c.rating, version: c.version.trim(), pos: x.pos, price: x.price, url: c.url });
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
await b.browser.close();
if (total === 0) { console.error('Keine Daten erhalten, Dateien bleiben unveraendert.'); process.exit(1); }

for (const set of touched) {
  const s = SETS[set], db = dbs[set];
  const cutoff = t - s.maxDays * 864e5;
  for (const [id, e] of Object.entries(db.cards)) {
    e.h.sort((x, y) => x[0] - y[0]);
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
  db.meta = { cards: Object.keys(db.cards).length };
  fs.writeFileSync(s.file, JSON.stringify(db));
}
console.log(`Fertig: ${total} Preise, ${pages} Seiten, ${Math.round((Date.now() - startedAt) / 60000)} Min.`);
