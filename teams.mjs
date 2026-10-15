// Holt das aktuelle TOTW-Team und das aktuelle Event-Team von FUT.GG (Seite "Squads").
// Neues TOTW: mittwochs ca. 19 Uhr, neues Event-Team: freitags ca. 19 Uhr. Der Dauerlauf prueft alle 15 Minuten.
// Kostenlos auf GitHub Actions (Playwright), kein Apify.
import fs from 'node:fs';

const DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DIR, { recursive: true });
const FILE = `${DIR}/teams.json`;
let prev = {};
try { prev = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

async function open(url, waitSel) {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (resp && resp.status() >= 400) { await page.close(); return null; }
    try { await page.waitForSelector(waitSel, { timeout: 20000 }); } catch {}
    await page.waitForTimeout(1500);
    return page;
  } catch (e) {
    console.error('Seite fehlgeschlagen:', url, String(e.message).split('\n')[0]);
    try { await page.close(); } catch {}
    return null;
  }
}

// Uebersicht aller Squads (mit Datum)
async function readIndex() {
  const page = await open('https://www.fut.gg/squads/', 'a[href*="/squads/"]');
  if (!page) return [];
  const list = await page.evaluate(() => {
    const out = [], seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/squads/"]')) {
      const m = a.getAttribute('href').match(/\/squads\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/i);
      if (!m || seen.has(a.href)) continue;
      seen.add(a.href);
      const lines = (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const alt = (a.querySelector('img') || {}).alt || '';
      out.push({ url: a.href, cat: m[1].toLowerCase(), slug: m[2].toLowerCase(), name: alt || lines[0] || m[2], lines, order: out.length });
    }
    return out;
  });
  await page.close();
  for (const s of list) {
    const d = s.lines.find((l) => /^[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}$/.test(l));
    s.date = d ? Date.parse(d + ' 12:00 GMT') : null;
    s.n = +(s.slug.match(/(\d+)$/) || [0, 0])[1];
  }
  return list;
}

// Spielerkarten eines Squads
async function readSquad(url) {
  const page = await open(url, 'img[alt*=" - "]');
  if (!page) return [];
  const cards = await page.evaluate(() => {
    const out = [], seen = new Set();
    const parse = (alt) => alt.match(/^(.+?) - (\d{2}) - (.+)$/);
    for (const a of document.querySelectorAll('a[href*="/players/"]')) {
      const img = a.querySelector('img'), am = img ? parse(img.alt || '') : null;
      if (!am) continue;
      const m = a.href.match(/\/27-(\d+)/), id = m ? m[1] : null, key = id || a.href;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, name: am[1].trim(), rating: +am[2], version: am[3].trim(), url: a.href });
    }
    if (!out.length) {
      for (const img of document.querySelectorAll('img[alt]')) {
        const am = parse(img.alt || '');
        if (am && !seen.has(img.alt)) { seen.add(img.alt); out.push({ id: null, name: am[1].trim(), rating: +am[2], version: am[3].trim(), url: '' }); }
      }
    }
    return out;
  });
  await page.close();
  return cards;
}

const result = { updated: new Date().toISOString(), totw: prev.totw || null, event: prev.event || null, errors: [] };
const idx = await readIndex();
console.log(`Squad-Uebersicht: ${idx.length} Eintraege`);
const newest = (arr) => arr.slice().sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.n - a.n) || (a.order - b.order))[0];

// --- TOTW ---
let totwSrc = newest(idx.filter((s) => s.cat === 'team-of-the-week'));
if (!totwSrc) {
  // Ersatzweg: totw-1, totw-2, ... durchprobieren, bis eine Seite leer ist
  let last = null;
  for (let n = Math.max(1, ((prev.totw && prev.totw.n) || 1) - 0); n < 80; n++) {
    const url = `https://www.fut.gg/squads/team-of-the-week/totw-${n}/`;
    const cards = await readSquad(url);
    if (cards.length < 5) break;
    last = { url, name: `TOTW ${n}`, n, date: null, cards };
  }
  if (last) totwSrc = { ...last, preloaded: true };
}
if (totwSrc) {
  const cards = totwSrc.preloaded ? totwSrc.cards : await readSquad(totwSrc.url);
  if (cards.length >= 5) result.totw = { name: totwSrc.name.replace(/\s*-\s*Squads.*$/i, ''), url: totwSrc.url, date: totwSrc.date || null, n: totwSrc.n || 0, cards };
  else result.errors.push(`TOTW-Seite ohne Karten: ${totwSrc.url}`);
} else result.errors.push('Kein TOTW-Squad gefunden');

// --- Event-Team ---
const evSrc = newest(idx.filter((s) => s.cat !== 'team-of-the-week'));
if (evSrc) {
  const cards = await readSquad(evSrc.url);
  if (cards.length >= 3) result.event = { name: evSrc.name, url: evSrc.url, date: evSrc.date || null, cat: evSrc.cat, cards };
  else result.errors.push(`Event-Seite ohne Karten: ${evSrc.url}`);
} else result.errors.push('Kein Event-Squad gefunden');

await browser.close();
for (const e of result.errors) console.error(e);
if (!result.totw && !result.event) { console.error('Keine Teams erhalten, teams.json bleibt unveraendert.'); process.exit(1); }
fs.writeFileSync(FILE, JSON.stringify(result));
console.log(`TOTW: ${result.totw ? result.totw.name + ' (' + result.totw.cards.length + ' Karten)' : '-'} | Event: ${result.event ? result.event.name + ' (' + result.event.cards.length + ' Karten)' : '-'}`);
