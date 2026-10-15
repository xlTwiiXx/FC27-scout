// Holt Preise von FUT.GG (Listen nach Rating, sortiert nach Preis).
// mode "auto":  zuerst direkt per Browser auf GitHub (kostenlos); wird das blockiert,
//               Ersatz ueber Apify (nur wenige Seiten, damit die Kosten klein bleiben).
// mode "direct": nur direkt.   mode "apify": nur Apify.
import fs from 'node:fs';

const cfg = {
  ratings: [86, 87, 88, 89, 90, 91],
  pages: 6,                // max. Seiten je Rating im Direktmodus
  mode: 'auto',
  delayMs: 4000,           // Pause zwischen Seiten (schont FUT.GG)
  maxPagesTotal: 60,       // Obergrenze je Lauf
  maxMinutes: 40,          // Zeitlimit je Lauf
  apifyPagesPerRating: 1,  // Ersatzweg: Seiten je Rating (Kosten!)
  ...JSON.parse(fs.readFileSync('config.json', 'utf8')),
};
const TOKEN = process.env.APIFY_TOKEN || '';
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let db = { updated: null, cards: {} };
try { db = JSON.parse(fs.readFileSync('prices.json', 'utf8')); } catch {}
db.cards = db.cards || {};

// "10.8K" -> 10800, "1.2M" -> 1200000, "850" -> 850, "EXTINCT" -> null
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

// Zeilen eines Kartenblocks -> {pos, gg, price}
export function parseLines(lines) {
  const pos = lines.find((l) => /^[A-Z]{2,3}$/.test(l));
  const gi = lines.findIndex((l) => /^\d{2}\.\d$/.test(l));
  if (gi < 0) return null;
  const cand = lines.slice(gi + 1).filter((l) => /^([\d.,]+[KM]?|EXTINCT)$/.test(l));
  if (!cand.length) return null;
  const price = num(cand[cand.length - 1]);
  if (!price) return null;
  return { pos: pos || '?', gg: parseFloat(lines[gi]), price };
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

// ---------- Ersatzweg: Apify ----------
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
let direct = cfg.mode !== 'apify';
let b = null;
if (direct) {
  try { b = await openBrowser(); }
  catch (e) { console.error('Browser nicht verfuegbar:', e.message); direct = false; }
}
if (!direct && cfg.mode === 'direct') { console.error('Direktmodus nicht moeglich.'); process.exit(1); }

let pages = 0, total = 0, nDirect = 0, nApify = 0;

outer:
for (const r of cfg.ratings) {
  const seen = new Set();
  for (let p = 1; p <= cfg.pages; p++) {
    if (pages >= cfg.maxPagesTotal || (Date.now() - startedAt) / 60000 > cfg.maxMinutes) {
      console.log('Limit erreicht, Lauf wird beendet.');
      break outer;
    }
    let cards = [];

    if (direct) {
      let res = await directPage(b.ctx, listUrl(r, p)); pages++;
      if (!res.cards.length && p === 1) {
        console.log(`Rating ${r}: leer, zweiter Versuch ...`);
        await sleep(6000);
        res = await directPage(b.ctx, listUrl(r, p)); pages++;
      }
      cards = res.cards;
      if (!cards.length && p === 1) {
        console.error(`Direkt blockiert oder leer (Rating ${r}): ${res.error || res.title || '-'}`);
        if (cfg.mode === 'direct') break outer;
        direct = false;
        console.log('Wechsle zu Apify (Ersatzweg).');
      } else if (!cards.length) {
        break; // Ende der Liste
      } else {
        nDirect++;
      }
    }

    if (!direct) {
      if (p > cfg.apifyPagesPerRating) break;
      cards = await apifyPage(listUrl(r, p)); pages++;
      if (cards.length < 5) { console.error(`Apify lieferte zu wenig (Rating ${r}).`); break; }
      nApify++;
    }

    const fresh = cards.filter((c) => !seen.has(c.id));
    if (!fresh.length) break;
    for (const c of fresh) {
      seen.add(c.id);
      const e = db.cards[c.id] || { h: [] };
      Object.assign(e, { name: c.name, rating: c.rating, version: c.version, pos: c.pos, url: c.url });
      e.h.push([t, c.price]);
      db.cards[c.id] = e;
    }
    total += fresh.length;
    console.log(`Rating ${r} Seite ${p}: ${fresh.length} Karten (${direct ? 'direkt' : 'Apify'})`);
    if (direct) await sleep(cfg.delayMs + Math.random() * 2000);
  }
}

if (b) await b.browser.close();
if (total === 0) { console.error('Keine Daten erhalten, prices.json bleibt unveraendert.'); process.exit(1); }

// Historie aufraeumen: letzte 3 Tage voll, aelter nur alle 3 Stunden, max. 14 Tage
const cutoff = t - 14 * 864e5;
for (const [id, e] of Object.entries(db.cards)) {
  let last = 0;
  e.h = e.h.filter((x) => {
    if (x[0] < cutoff) return false;
    if (x[0] >= t - 3 * 864e5) { last = x[0]; return true; }
    if (x[0] - last >= 3 * 36e5) { last = x[0]; return true; }
    return false;
  });
  if (!e.h.length) delete db.cards[id];
}

db.updated = new Date(t).toISOString();
db.meta = { directPages: nDirect, apifyPages: nApify, cards: total, mode: cfg.mode };
fs.writeFileSync('prices.json', JSON.stringify(db));
console.log(`Fertig: ${total} Preise, ${nDirect} Seiten direkt, ${nApify} Seiten ueber Apify.`);
