// Holt das aktuelle TOTW-Team und das aktuelle Event-Team von FUT.GG (Squads).
// Neues TOTW: mittwochs ca. 19 Uhr, neues Event-Team: freitags ca. 19 Uhr.
// Regel: Massgeblich ist die FUT.GG-Uebersicht (mit Zufallsparameter geladen). Hoechstens 2 hoehere Nummern werden zusaetzlich geprueft.
// FUT.GG zeigt auch fuer nicht vorhandene Nummern eine Seite mit (aelteren) Karten. Deshalb zaehlt eine hoehere Nummer nur, wenn die Karten
// auf der Seite WIRKLICH spaeter erschienen sind als das Team der Uebersicht. Das Erscheinungsdatum wird bei 3 Karten auf deren Spielerseite gelesen.
// Kostenlos auf GitHub Actions (Playwright), kein Apify.
import fs from 'node:fs';

const DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DIR, { recursive: true });
const FILE = `${DIR}/teams.json`;
let prev = {};
try { prev = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
if (prev.v !== 3) prev = {}; // aelterer Stand (eventuell mit falschen Nummern): nicht weiterverwenden
const DAY = 864e5;

const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const humanize = (cat) => cat.split('-').map((w, i) => (i && /^(of|for|the|and|to)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
const nameOf = (cat, n) => (cat === 'team-of-the-week' ? `TOTW ${n}` : `${humanize(cat)} ${n}`);
const imPath = (u) => { const m = String(u || '').match(/game-assets\.fut\.gg\/(?:cdn-cgi\/image\/[^/]+\/)?([^?#]+)/); return m && !/placeholder/i.test(m[1]) ? m[1] : ''; };
function parseDate(text) {
  let m = text.match(/([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})/);
  if (m) { const d = Date.parse(`${m[1]} ${m[2]}, ${m[3]} 12:00 GMT`); if (d) return d; }
  m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/); // auch "16.10.26"; Name und Datum koennen ohne Leerzeichen zusammenhaengen
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1], 12);
  m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 12) : null;
}
function monthDay(s) { // "Oct 14" -> Zeitpunkt (12 Uhr UTC), Jahr aus dem Zusammenhang
  const m = String(s).match(/([A-Z][a-z]{2})[a-z]*\.? (\d{1,2})/);
  if (!m) return null;
  const mon = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]);
  if (mon < 0 || mon % 3) return null;
  const y = new Date().getUTCFullYear();
  let t = Date.UTC(y, mon / 3, +m[2], 12);
  if (t > Date.now() + 2 * DAY) t = Date.UTC(y - 1, mon / 3, +m[2], 12);
  return t;
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1280, height: 1000 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});
const cb = () => `cb=${Date.now()}`;

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
        out.push({ url: a.href.split('?')[0], cat: m[1].toLowerCase(), slug: m[2].toLowerCase(), text: (a.innerText || '').replace(/\s+/g, ' ').trim(), order: out.length });
      }
      return out;
    });
    for (const s of list) { s.n = +(s.slug.match(/(\d+)$/) || [0, 0])[1]; s.date = parseDate(s.text); s.name = nameOf(s.cat, s.n); }
    return list.filter((s) => s.n > 0);
  } catch (e) { console.error('Uebersicht fehlgeschlagen:', String(e.message).split('\n')[0]); return []; }
  finally { await page.close(); }
}

async function readSquad(url) { // null = Seite nicht ladbar
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(`${url}?${cb()}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (resp && resp.status() >= 400) return null;
    try { await page.waitForFunction(() => document.querySelectorAll('img[alt*=" - "]').length >= 5, null, { timeout: 30000 }); } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    for (const f of [0.5, 1]) { try { await page.evaluate((x) => window.scrollTo(0, document.body.scrollHeight * x), f); } catch {} await page.waitForTimeout(1200); }
    // warten, bis sich die Kartenzahl nicht mehr aendert
    let last = -1;
    for (let i = 0; i < 6; i++) { const c = await page.evaluate(() => document.querySelectorAll('a[href*="/players/"] img[alt*=" - "]').length); if (c === last) break; last = c; await page.waitForTimeout(1500); }
    const cards = await page.evaluate(() => {
      const out = [], seen = new Set();
      const parse = (alt) => alt.match(/^(.+?) - (\d{2}) - (.+)$/);
      const src = (img) => [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-lazy-src'), (img.getAttribute('srcset') || '').split(' ')[0]].find((u) => u && u.includes('game-assets.fut.gg')) || '';
      for (const a of document.querySelectorAll('a[href*="/players/"]')) {
        const img = a.querySelector('img'), am = img ? parse(img.alt || '') : null;
        if (!am) continue;
        const m = a.href.match(/\/27-(\d+)/), id = m ? m[1] : null, key = id || a.href;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id, name: am[1].trim(), rating: +am[2], version: am[3].trim(), url: a.href, im: src(img) });
      }
      return out;
    });
    for (const c of cards) c.im = imPath(c.im);
    return { cards };
  } catch (e) { console.error('Squad fehlgeschlagen:', url, String(e.message).split('\n')[0]); return null; }
  finally { await page.close(); }
}

// Erscheinungsdatum einer Karte: steht auf der Spielerseite neben der Karte ("Team of the week Oct 14")
async function cardDate(c) {
  const m = (c.url || '').match(/^(https:\/\/www\.fut\.gg\/players\/[^/]+\/)27-(\d+)\/?/);
  if (!m) return null;
  const page = await ctx.newPage();
  try {
    await page.goto(`${m[1]}?${cb()}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    try { await page.waitForSelector('a[href*="/27-"]', { timeout: 15000 }); } catch {}
    const txt = await page.evaluate((id) => {
      for (const a of document.querySelectorAll(`a[href*="/27-${id}"]`)) {
        const t = (a.innerText || '').replace(/\s+/g, ' ');
        const mm = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})\b/);
        if (mm) return mm[0];
      }
      return null;
    }, m[2]);
    return txt ? monthDay(txt) : null;
  } catch { return null; } finally { await page.close(); }
}
// Datum eines ganzen Teams: 3 Karten (verschiedene Spieler) pruefen, haeufigstes Datum zaehlt
async function squadDate(cards) {
  const seenP = new Set(), pick = [];
  const idx = [0, Math.floor(cards.length / 2), cards.length - 1];
  for (const i of idx) { const c = cards[i]; const p = ((c && c.url) || '').split('/27-')[0]; if (c && c.url && !seenP.has(p)) { seenP.add(p); pick.push(c); } }
  const ds = (await Promise.all(pick.map(cardDate))).filter(Boolean);
  if (!ds.length) return null;
  const cnt = new Map();
  for (const d of ds) cnt.set(d, (cnt.get(d) || 0) + 1);
  const [d, n] = [...cnt].sort((a, b) => b[1] - a[1])[0];
  return n >= Math.min(2, ds.length) ? d : null;
}

// Neue Events erkennen, ohne dass der Name vorher bekannt sein muss: Versionen, die erst seit kurzem am Markt sind
const BASE = /^(rare|common|non-?rare)$|team of the week|totw|potm|player of the month|icon|hero|foundation|champions|ones to watch|sbc/i;
const freshVersions = new Map();
for (const f of ['prices.json', 'prices-low.json']) {
  try {
    const d = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
    for (const c of Object.values(d.cards || {})) if (c.version && !BASE.test(c.version) && c.fs > 0 && c.fs > Date.now() - 10 * DAY) freshVersions.set(c.version, (freshVersions.get(c.version) || 0) + 1);
  } catch {}
}
const newCats = [...freshVersions].filter(([, n]) => n >= 3).map(([v]) => slugify(v)).filter(Boolean);

// Probieren nach hoeheren Nummern nur einmal pro Stunde und rund um die Veroeffentlichung (Mi/Fr ab 19 Uhr)
const nowD = new Date(), wd = nowD.getUTCDay(), hr = nowD.getUTCHours();
const releaseWindow = ((wd === 3 || wd === 5) && hr >= 16) || ((wd === 4 || wd === 6) && hr < 4);
const PROBE = !prev.totw || !prev.event || releaseWindow || nowD.getUTCMinutes() < 15;

const idx0 = await readIndex(false);
const idx1 = await readIndex(true); // zweiter Abruf mit anderer Adresse, falls der erste aus dem Zwischenspeicher kam
const seenUrl = new Set(idx0.map((s) => s.url));
const idx = [...idx0, ...idx1.filter((s) => !seenUrl.has(s.url))];
const fmtD = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'ohne Datum');
console.log(`Squad-Uebersicht: ${idx.length} Eintraege: ` + idx.slice(0, 8).map((s) => `${s.name} (${fmtD(s.date)})`).join(', '));
const result = { v: 3, updated: new Date().toISOString(), totw: null, event: null, errors: [] };

// Eine hoehere Nummer gilt nur, wenn ihre Karten mindestens 3 Tage spaeter erschienen sind als das Team davor
async function probeHigher(cat, baseN, baseDate, extra) {
  let cur = null;
  for (let n = baseN + 1; n <= baseN + 2; n++) {
    const url = `https://www.fut.gg/squads/${cat}/${cat === 'team-of-the-week' ? 'totw' : cat}-${n}/`;
    const s = await readSquad(url);
    if (!s || s.cards.length < (cat === 'team-of-the-week' ? 15 : 8)) { console.log(`${nameOf(cat, n)}: Seite ohne Karten, Suche beendet`); break; }
    const rel = await squadDate(s.cards);
    const refDate = (cur && cur.date) || baseDate;
    const okNew = rel && (refDate ? rel >= refDate + 3 * DAY : rel >= Date.now() - 10 * DAY && rel <= Date.now() + DAY);
    if (!okNew) { console.log(`${nameOf(cat, n)}: Karten von ${fmtD(rel)}, nicht neuer als ${fmtD(refDate)}, kein neues Team (FUT.GG zeigt dort aeltere Karten)`); break; }
    console.log(`${nameOf(cat, n)} bestaetigt: Karten erschienen am ${fmtD(rel)}`);
    cur = { cat, n, date: rel, url, cards: s.cards };
  }
  return cur;
}

// ---------------- TOTW ----------------
const totwIdx = idx.filter((s) => s.cat === 'team-of-the-week').sort((a, b) => b.n - a.n);
const t0 = totwIdx[0] || null;
if (t0) {
  let cur = { cat: 'team-of-the-week', n: t0.n, date: t0.date, url: t0.url, cards: null };
  if (PROBE) { const hi = await probeHigher('team-of-the-week', t0.n, t0.date); if (hi) cur = hi; }
  if (prev.totw && prev.totw.n === cur.n && prev.totw.cards && prev.totw.cards.length >= 15 && prev.totw.cards.every((c) => 'im' in c)) result.totw = { ...prev.totw, date: cur.date || prev.totw.date };
  else {
    const cards = cur.cards || ((await readSquad(cur.url)) || {}).cards || [];
    if (cards.length >= 10) {
      let date = cur.date;
      const rel = await squadDate(cards);
      if (rel && date && Math.abs(rel - date) > 2 * DAY) console.warn(`Warnung: Die Karten auf der Seite von ${nameOf('team-of-the-week', cur.n)} erschienen am ${fmtD(rel)}, die Uebersicht nennt ${fmtD(date)}.`);
      if (!date) date = rel;
      result.totw = { name: nameOf('team-of-the-week', cur.n), n: cur.n, url: cur.url, date, cards };
    } else result.errors.push(`TOTW ${cur.n}: Seite ohne Karten`);
  }
} else result.errors.push('Kein TOTW in der Uebersicht');

// ---------------- Event-Team ----------------
const evIdx = idx.filter((s) => s.cat !== 'team-of-the-week').sort((a, b) => ((b.date || 0) - (a.date || 0)) || (a.order - b.order));
const e0 = evIdx[0] || null;
let curE = e0 ? { cat: e0.cat, n: e0.n, date: e0.date, url: e0.url, cards: null } : null;
if (PROBE) {
  if (e0) { const hi = await probeHigher(e0.cat, e0.n, e0.date); if (hi) curE = hi; }
  for (const c of newCats) { // neue Kategorie, die die Uebersicht noch nicht kennt
    if (idx.some((s) => s.cat === c)) continue;
    const hi = await probeHigher(c, 0, (curE && curE.date) || null);
    if (hi && (!curE || hi.date > (curE.date || 0))) curE = hi;
  }
}
if (curE) {
  if (prev.event && prev.event.url === curE.url && prev.event.cards && prev.event.cards.length >= 8 && prev.event.cards.every((c) => 'im' in c)) result.event = { ...prev.event, date: curE.date || prev.event.date };
  else {
    const cards = curE.cards || ((await readSquad(curE.url)) || {}).cards || [];
    if (cards.length >= 8) result.event = { name: nameOf(curE.cat, curE.n), cat: curE.cat, n: curE.n, url: curE.url, date: curE.date || (await squadDate(cards)), cards };
    else result.errors.push(`Event ${nameOf(curE.cat, curE.n)}: Seite ohne Karten`);
  }
} else result.errors.push('Kein Event-Squad in der Uebersicht');

await browser.close();
for (const e of result.errors) console.error(e);
if (!result.totw && !result.event) { console.error('Keine Teams erhalten, teams.json bleibt unveraendert.'); process.exit(1); }
if (!result.totw) result.totw = prev.totw || null;
if (!result.event) result.event = prev.event || null;
fs.writeFileSync(FILE, JSON.stringify(result));
console.log(`TOTW: ${result.totw ? result.totw.name + ' (' + result.totw.cards.length + ' Karten, ' + fmtD(result.totw.date) + ')' : '-'} | Event: ${result.event ? result.event.name + ' (' + result.event.cards.length + ' Karten, ' + fmtD(result.event.date) + ')' : '-'}`);
