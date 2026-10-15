// Katalog ALLER Karten ab Rating 75 (auch ohne Marktpreis, z. B. EXTINCT) fuer den Teambuilder.
// Liest die FUT.GG-Spielerlisten pro Rating ohne den Marktfilter. Kostenlos auf GitHub Actions (Playwright), kein Apify.
import fs from 'node:fs';

const range = (a, b) => Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => (a > b ? a - i : a + i));
const cfg = { catalogRatings: range(99, 75), catalogPages: 90, catalogConcurrency: 3, delayMs: 3000, catalogMaxMinutes: 20, ...JSON.parse(fs.readFileSync('config.json', 'utf8')) };
const DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DIR, { recursive: true });
const FILE = `${DIR}/catalog.json`;
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let prev = { cards: {} };
try { prev = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
prev.cards = prev.cards || {};

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

const url = (r, p) => `https://www.fut.gg/players/?overall__gte=${r}&overall__lte=${r}&sorts=current_price` + (p > 1 ? `&page=${p}` : '');

async function readPage(u) {
  const page = await ctx.newPage();
  let status = 0;
  try {
    const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
    status = resp ? resp.status() : 0;
    await page.waitForFunction(
      () => document.querySelector('a[href*="/27-"] img') || /no (players|results)|nothing (found|here)/i.test(document.body.innerText),
      null, { timeout: 25000 });
    await page.waitForTimeout(2000);
    const raw = await page.evaluate(() => {
      const out = [], seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/players/"]')) {
        const m = a.href.match(/\/players\/([^/]+)\/27-(\d+)\/?/);
        if (!m || seen.has(m[2])) continue;
        const img = a.querySelector('img');
        const am = (img ? img.alt : '').match(/^(.+?) - (\d{2}) - (.+)$/);
        if (!am) continue;
        seen.add(m[2]);
        out.push({ id: m[2], name: am[1], rating: +am[2], version: am[3], url: a.href,
          im: img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '',
          lines: (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean) });
      }
      return out;
    });
    const cards = raw.map((c) => ({
      id: c.id, name: c.name.trim(), rating: c.rating, version: c.version.trim(), url: c.url,
      pos: c.lines.find((l) => /^[A-Z]{2,3}$/.test(l)) || '?',
      im: (c.im.split('futgg-player-item-card/')[1] || '').split('?')[0],
    }));
    return { cards, status, title: await page.title() };
  } catch (e) {
    let title = ''; try { title = await page.title(); } catch {}
    return { cards: [], error: String(e.message).split('\n')[0], status, title };
  } finally { await page.close(); }
}
const blocked = (res) => res.status >= 400 || /just a moment|attention required|access denied|verify you are human/i.test(res.title || '');

const fresh = {}, perRating = {};
let hardBlocks = 0;
const stop = () => hardBlocks >= 3 || (Date.now() - startedAt) / 60000 > cfg.catalogMaxMinutes;

async function runRating(r) {
  const seen = new Set();
  for (let p = 1; p <= cfg.catalogPages; p++) {
    if (stop()) return;
    let res = await readPage(url(r, p));
    if (!res.cards.length && p === 1 && blocked(res)) { await sleep(6000); res = await readPage(url(r, p)); }
    if (!res.cards.length) {
      if (p === 1 && blocked(res)) { hardBlocks++; console.error(`Rating ${r}: blockiert (Status ${res.status}, ${res.title || res.error})`); }
      else if (p === 1) console.log(`Rating ${r}: keine Karten`);
      return;
    }
    const nw = res.cards.filter((c) => !seen.has(c.id));
    if (!nw.length) return;
    for (const c of nw) { seen.add(c.id); fresh[c.id] = { name: c.name, rating: c.rating, version: c.version, pos: c.pos, im: c.im, url: c.url }; }
    perRating[r] = (perRating[r] || 0) + nw.length;
    await sleep(cfg.delayMs + Math.random() * 1500);
  }
}
const queue = [...cfg.catalogRatings];
await Promise.all(Array.from({ length: cfg.catalogConcurrency }, async () => { while (queue.length && !stop()) await runRating(queue.shift()); }));
await browser.close();

const total = Object.keys(fresh).length;
if (!total) { console.error('Keine Karten erhalten, catalog.json bleibt unveraendert.'); process.exit(1); }
const cards = { ...prev.cards, ...fresh }; // nie etwas verlieren, falls ein Rating mal nicht lud
fs.writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), n: Object.keys(cards).length, cards }));
console.log('Karten je Rating:', Object.entries(perRating).sort((a, b) => b[0] - a[0]).map(([r, n]) => `${r}:${n}`).join(' '));
console.log(`Katalog fertig: ${total} aktuell gelesen, ${Object.keys(cards).length} gesamt, ${Math.round((Date.now() - startedAt) / 60000)} Min.`);
