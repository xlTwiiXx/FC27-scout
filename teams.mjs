// Holt das aktuelle TOTW-Team und das aktuelle Event-Team von FUT.GG (Squads).
// Neues TOTW: mittwochs ca. 19 Uhr, neues Event-Team: freitags ca. 19 Uhr. Der Dauerlauf prueft alle 15 Minuten.
// Die Uebersichtsseite kann bei FUT.GG veraltet ausgeliefert werden. Deshalb wird sie mit Zufallsparameter geladen
// und zusaetzlich geprueft, ob schon eine hoehere Nummer existiert (z. B. TOTW 6 nach TOTW 5, Future Stars 2 nach Future Stars 1).
// Kostenlos auf GitHub Actions (Playwright), kein Apify.
import fs from 'node:fs';

const DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DIR, { recursive: true });
const FILE = `${DIR}/teams.json`;
let prev = {};
try { prev = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const known = prev.cats || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1280, height: 1000 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});
const cb = () => `cb=${Date.now()}`;
// Nach hoeheren Nummern wird nur einmal pro Stunde und rund um die Veroeffentlichung (Mi/Fr ab 19 Uhr) gesucht, das spart Seitenaufrufe
const nowD = new Date(), wd = nowD.getUTCDay(), hr = nowD.getUTCHours();
const releaseWindow = ((wd === 3 || wd === 5) && hr >= 16) || ((wd === 4 || wd === 6) && hr < 4);
let PROBE = !prev.totw || !prev.event || releaseWindow || nowD.getUTCMinutes() < 15;

async function readIndex(alt) {
  const page = await ctx.newPage();
  try {
    await page.goto(alt ? `https://www.fut.gg/squads/?page=1&${cb()}` : `https://www.fut.gg/squads/?${cb()}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    try { await page.waitForSelector('a[href*="/squads/"]', { timeout: 20000 }); } catch {}
    await page.waitForTimeout(1500);
    const list = await page.evaluate(() => {
      const out = [], seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/squads/"]')) {
        const m = a.getAttribute('href').match(/\/squads\/([a-z0-9-]+)\/([a-z0-9-]+)\/?(?:\?.*)?$/i);
        if (!m || seen.has(a.href)) continue;
        seen.add(a.href);
        const lines = (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const alt = (a.querySelector('img') || {}).alt || '';
        out.push({ url: a.href.split('?')[0], cat: m[1].toLowerCase(), slug: m[2].toLowerCase(), name: (lines[0] || alt || m[2]), text: lines.join(' | '), order: out.length });
      }
      return out;
    });
    for (const s of list) {
      const d = s.text.match(/([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})/);
      s.date = d ? Date.parse(`${d[1]} ${d[2]}, ${d[3]} 12:00 GMT`) : null;
      s.n = +(s.slug.match(/(\d+)$/) || [0, 0])[1];
    }
    return list;
  } catch (e) { console.error('Uebersicht fehlgeschlagen:', String(e.message).split('\n')[0]); return []; }
  finally { await page.close(); }
}

const readIndexAlt = () => readIndex(true);

// Spielerkarten eines Squads. null = Seite existiert nicht
async function readSquad(url) {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(`${url}?${cb()}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (resp && resp.status() >= 400) return null;
    try { await page.waitForFunction(() => document.querySelectorAll('img[alt*=" - "]').length >= 5, null, { timeout: 30000 }); } catch {}
    for (const f of [0.5, 1]) { try { await page.evaluate((x) => window.scrollTo(0, document.body.scrollHeight * x), f); } catch {} await page.waitForTimeout(1200); }
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
    const title = ((await page.title()) || '').split(/\s+-\s+Squads/i)[0].trim();
    return { cards, title };
  } catch (e) { console.error('Squad fehlgeschlagen:', url, String(e.message).split('\n')[0]); return null; }
  finally { await page.close(); }
}

// Neue Events erkennen, ohne dass der Name vorher bekannt sein muss: Versionen, die erst seit kurzem am Markt sind
const BASE = /^(rare|common|non-?rare)$|team of the week|totw|potm|player of the month|icon|hero|foundation|champions|ones to watch|sbc/i;
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const freshVersions = new Map(), evid = {};
for (const f of ['prices.json', 'prices-low.json']) {
  try {
    const d = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
    for (const c of Object.values(d.cards || {})) if (c.version && !BASE.test(c.version) && c.fs > 0 && c.fs > Date.now() - 10 * 864e5) { freshVersions.set(c.version, (freshVersions.get(c.version) || 0) + 1); const sl = slugify(c.version); evid[sl] = Math.max(evid[sl] || 0, c.fs); }
  } catch {}
}
const newCats = [...freshVersions].filter(([, n]) => n >= 3).map(([v]) => slugify(v)).filter((s) => s && !(s in known));
if (newCats.length) console.log('Neue Versionen am Markt (moegliche neue Events):', newCats.join(', '));
const idx0 = await readIndex(false);
// zweiter Abruf mit anderer Adresse, falls die erste Antwort veraltet aus dem Zwischenspeicher kam
const idx1 = await readIndexAlt();
const seenUrl = new Set(idx0.map((s) => s.url));
const idx = [...idx0, ...idx1.filter((s) => !seenUrl.has(s.url))];
console.log(`Squad-Uebersicht: ${idx.length} Eintraege: ` + idx.slice(0, 8).map((s) => `${s.name}${s.date ? ' (' + new Date(s.date).toISOString().slice(0, 10) + ')' : ''}`).join(', '));
const result = { updated: new Date().toISOString(), totw: prev.totw || null, event: prev.event || null, cats: { ...known }, errors: [] };

// ---------------- TOTW ----------------
const totwIdx = idx.filter((s) => s.cat === 'team-of-the-week');
let totwN = Math.max(0, ...totwIdx.map((s) => s.n), (prev.totw && prev.totw.n) || 0);
let totwDate = (totwIdx.find((s) => s.n === totwN) || {}).date || null;
// gibt es schon ein hoeheres TOTW als in der Uebersicht?
for (let n = totwN + 1; PROBE && n <= totwN + 3; n++) {
  const s = await readSquad(`https://www.fut.gg/squads/team-of-the-week/totw-${n}/`);
  if (s && s.cards.length >= 15) { totwN = n; totwDate = Date.now(); console.log(`TOTW ${n} gefunden (hoeher als in der Uebersicht)`); } else break;
}
if (totwN > 0) {
  const url = `https://www.fut.gg/squads/team-of-the-week/totw-${totwN}/`;
  if (!result.totw || result.totw.n !== totwN || !result.totw.cards || result.totw.cards.length < 15) {
    const s = await readSquad(url);
    if (s && s.cards.length >= 10) result.totw = { name: `TOTW ${totwN}`, n: totwN, url, date: totwDate, cards: s.cards };
    else result.errors.push(`TOTW ${totwN}: Seite ohne Karten`);
  }
} else result.errors.push('Kein TOTW gefunden');

// ---------------- Event-Team ----------------
if (newCats.length) PROBE = true;
const cats = new Set([...Object.keys(known), ...newCats, ...idx.filter((s) => s.cat !== 'team-of-the-week').map((s) => s.cat)]);
const cands = [];
for (const cat of cats) {
  const inIdx = idx.filter((s) => s.cat === cat);
  let n = Math.max(0, ...inIdx.map((s) => s.n), known[cat] || 0);
  const base = inIdx.find((s) => s.n === n);
  // Nummer nur aus frueheren Funden bekannt (Uebersicht veraltet): Datum des bisherigen Event-Teams behalten, sonst als neu behandeln
  let date = base ? base.date : (prev.event && prev.event.cat === cat && prev.event.n === n ? prev.event.date || Date.now() : Math.max(evid[cat] || 0, Date.now() - 864e5));
  let probed = false;
  for (let k = n + 1; PROBE && k <= n + 2; k++) {
    const s = await readSquad(`https://www.fut.gg/squads/${cat}/${cat}-${k}/`);
    if (s && s.cards.length >= 8) { n = k; date = Math.max(evid[cat] || 0, Date.now() - 864e5); probed = true; console.log(`${cat}-${k} gefunden (hoeher als in der Uebersicht)`); } else break;
  }
  if (n > 0) { result.cats[cat] = n; cands.push({ cat, n, date, url: `https://www.fut.gg/squads/${cat}/${cat}-${n}/`, name: base && !probed ? base.name : null, probed }); }
}
// neueste Karte gewinnt (Datum aus der Uebersicht oder jetzt, falls neu gefunden)
cands.sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.n - a.n));
for (const c of cands) {
  if (prev.event && prev.event.url === c.url && prev.event.cards && prev.event.cards.length >= 8) { result.event = { ...prev.event, date: c.date || prev.event.date }; break; }
  const s = await readSquad(c.url);
  if (s && s.cards.length >= 8) { result.event = { name: s.title || c.name || `${c.cat} ${c.n}`, cat: c.cat, n: c.n, url: c.url, date: c.date, cards: s.cards }; break; }
  result.errors.push(`Event ${c.cat} ${c.n}: Seite ohne Karten`);
}
if (!cands.length) result.errors.push('Kein Event-Squad gefunden');

await browser.close();
for (const e of result.errors) console.error(e);
if (!result.totw && !result.event) { console.error('Keine Teams erhalten, teams.json bleibt unveraendert.'); process.exit(1); }
fs.writeFileSync(FILE, JSON.stringify(result));
console.log(`TOTW: ${result.totw ? result.totw.name + ' (' + result.totw.cards.length + ' Karten)' : '-'} | Event: ${result.event ? result.event.name + ' (' + result.event.cards.length + ' Karten)' : '-'}`);
