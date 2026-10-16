// Holt das aktuelle TOTW-Team und das aktuelle Event-Team von FUT.GG (Squads).
// Neues TOTW: mittwochs ca. 19 Uhr, neues Event-Team: freitags ca. 19 Uhr. Der Dauerlauf prueft laufend.
// Regel: Massgeblich ist die FUT.GG-Uebersicht (mit Zufallsparameter geladen, damit sie nicht veraltet kommt).
// Nur falls sie hinter der Veroeffentlichung herhinkt, werden hoechstens 2 hoehere Nummern geprueft. Eine solche Seite zaehlt nur,
// wenn Titel und Karten zur Nummer passen (FUT.GG liefert auch fuer nicht vorhandene Nummern eine Seite mit vielen Karten aus).
// Kostenlos auf GitHub Actions (Playwright), kein Apify.
import fs from 'node:fs';

const DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DIR, { recursive: true });
const FILE = `${DIR}/teams.json`;
let prev = {};
try { prev = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

const bf = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
function lastRelease(wd, h) { // letzter Termin (deutsche Zeit) zu Wochentag und Uhrzeit, z. B. ('Wed', 19)
  const now = Date.now();
  let t = now - (now % 36e5);
  for (let i = 0; i < 24 * 8; i++, t -= 36e5) {
    const o = {};
    for (const p of bf.formatToParts(new Date(t))) o[p.type] = p.value;
    if (o.weekday === wd && +o.hour === h) return t;
  }
  return Date.now();
}
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const humanize = (cat) => cat.split('-').map((w, i) => (i && /^(of|for|the|and|to)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
const nameOf = (cat, n) => (cat === 'team-of-the-week' ? `TOTW ${n}` : `${humanize(cat)} ${n}`);
function parseDate(text) {
  let m = text.match(/([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})/);
  if (m) { const d = Date.parse(`${m[1]} ${m[2]}, ${m[3]} 12:00 GMT`); if (d) return d; }
  m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/); // auch "16.10.26"; Name und Datum koennen ohne Leerzeichen zusammenhaengen
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1], 12);
  m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 12) : null;
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
    for (const s of list) {
      s.n = +(s.slug.match(/(\d+)$/) || [0, 0])[1];
      s.date = parseDate(s.text);
      s.name = nameOf(s.cat, s.n); // Name aus der Adresse, nicht aus dem Text (dort haengt das Datum direkt an der Nummer)
    }
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

// Ist das wirklich dieses Team? Titel muss zur Nummer passen, und die Karten muessen (zu mind. 60 %) dieselbe Version tragen.
function validSquad(s, cat, n) {
  if (!s || s.cards.length < (cat === 'team-of-the-week' ? 15 : 8)) return false;
  const ts = slugify(s.title);
  const ok = cat === 'team-of-the-week' ? [`totw-${n}`, `team-of-the-week-${n}`] : [`${cat}-${n}`];
  if (!ts || !ok.includes(ts)) return false;
  const cnt = {};
  for (const c of s.cards) { const v = slugify(c.version); cnt[v] = (cnt[v] || 0) + 1; }
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < s.cards.length * 0.6) return false;
  if (cat === 'team-of-the-week' && !/team-of-the-week|totw/.test(top[0])) return false;
  return true;
}

// Neue Events erkennen, ohne dass der Name vorher bekannt sein muss: Versionen, die erst seit kurzem am Markt sind
const BASE = /^(rare|common|non-?rare)$|team of the week|totw|potm|player of the month|icon|hero|foundation|champions|ones to watch|sbc/i;
const freshVersions = new Map();
for (const f of ['prices.json', 'prices-low.json']) {
  try {
    const d = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
    for (const c of Object.values(d.cards || {})) if (c.version && !BASE.test(c.version) && c.fs > 0 && c.fs > Date.now() - 10 * 864e5) freshVersions.set(c.version, (freshVersions.get(c.version) || 0) + 1);
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
const result = { updated: new Date().toISOString(), totw: null, event: null, errors: [] };

// ---------------- TOTW ----------------
const totwIdx = idx.filter((s) => s.cat === 'team-of-the-week');
let top = totwIdx.slice().sort((a, b) => b.n - a.n)[0] || null;
let totwN = top ? top.n : 0, totwDate = top ? top.date : null;
if (!top && prev.totw && prev.totw.n < 100) { totwN = prev.totw.n; totwDate = prev.totw.date; } // Uebersicht nicht lesbar: letzten Stand behalten
const baseN = totwN;
for (let n = baseN + 1; PROBE && baseN > 0 && n <= baseN + 2; n++) {
  const s = await readSquad(`https://www.fut.gg/squads/team-of-the-week/totw-${n}/`);
  if (!validSquad(s, 'team-of-the-week', n)) break;
  console.log(`TOTW ${n} bestaetigt (Uebersicht kennt nur TOTW ${baseN})`);
  totwN = n; totwDate = lastRelease('Wed', 19);
}
if (totwN > 0) {
  const url = `https://www.fut.gg/squads/team-of-the-week/totw-${totwN}/`;
  if (prev.totw && prev.totw.n === totwN && prev.totw.cards && prev.totw.cards.length >= 15) result.totw = { ...prev.totw, date: totwDate || prev.totw.date };
  else {
    const s = await readSquad(url);
    if (s && s.cards.length >= 10) result.totw = { name: `TOTW ${totwN}`, n: totwN, url, date: totwDate, cards: s.cards };
    else result.errors.push(`TOTW ${totwN}: Seite ohne Karten`);
  }
} else result.errors.push('Kein TOTW gefunden');

// ---------------- Event-Team ----------------
const byCat = {};
for (const s of idx.filter((x) => x.cat !== 'team-of-the-week')) if (!byCat[s.cat] || s.n > byCat[s.cat].n) byCat[s.cat] = s;
let cands = Object.values(byCat).map((s) => ({ cat: s.cat, n: s.n, date: s.date, order: s.order, url: s.url }));
const byNew = (a, b) => ((b.date || 0) - (a.date || 0)) || (a.order - b.order) || (b.n - a.n);
cands.sort(byNew);
// Nur die zwei juengsten Kategorien (und neue Versionen vom Markt) auf hoehere Nummern pruefen
const probeCats = [...cands.slice(0, 2).map((c) => ({ cat: c.cat, n: c.n })), ...newCats.filter((c) => !byCat[c]).map((c) => ({ cat: c, n: 0 }))];
for (const pc of probeCats) {
  for (let k = pc.n + 1; PROBE && k <= pc.n + 2; k++) {
    const s = await readSquad(`https://www.fut.gg/squads/${pc.cat}/${pc.cat}-${k}/`);
    if (!validSquad(s, pc.cat, k)) break;
    console.log(`${nameOf(pc.cat, k)} bestaetigt (Uebersicht kennt nur ${pc.n ? nameOf(pc.cat, pc.n) : 'diese Kategorie nicht'})`);
    cands.push({ cat: pc.cat, n: k, date: lastRelease('Fri', 19), order: -1, url: `https://www.fut.gg/squads/${pc.cat}/${pc.cat}-${k}/` });
  }
}
cands.sort(byNew);
console.log('Event-Kandidaten: ' + cands.slice(0, 4).map((c) => `${nameOf(c.cat, c.n)} (${fmtD(c.date)})`).join(', '));
for (const c of cands) {
  if (prev.event && prev.event.url === c.url && prev.event.cards && prev.event.cards.length >= 8) { result.event = { ...prev.event, date: c.date || prev.event.date }; break; }
  const s = await readSquad(c.url);
  if (s && s.cards.length >= 8) { result.event = { name: nameOf(c.cat, c.n), cat: c.cat, n: c.n, url: c.url, date: c.date, cards: s.cards }; break; }
  result.errors.push(`Event ${nameOf(c.cat, c.n)}: Seite ohne Karten`);
}
if (!cands.length) result.errors.push('Kein Event-Squad gefunden');

await browser.close();
for (const e of result.errors) console.error(e);
if (!result.totw && !result.event) { console.error('Keine Teams erhalten, teams.json bleibt unveraendert.'); process.exit(1); }
if (!result.totw) result.totw = prev.totw && prev.totw.n < 100 ? prev.totw : null;
if (!result.event) result.event = prev.event && prev.event.n < 100 ? prev.event : null;
fs.writeFileSync(FILE, JSON.stringify(result));
console.log(`TOTW: ${result.totw ? result.totw.name + ' (' + result.totw.cards.length + ' Karten, ' + fmtD(result.totw.date) + ')' : '-'} | Event: ${result.event ? result.event.name + ' (' + result.event.cards.length + ' Karten, ' + fmtD(result.event.date) + ')' : '-'}`);
