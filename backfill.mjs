// Holt die Preishistorie (seit Release) von den FUT.GG-Spielerseiten.
// Die Seite laedt ihr Preisdiagramm per Netzwerkanfrage nach; wir lesen diese Antworten im Browser mit.
// Jeder Lauf bearbeitet einen Teil der Karten (backfillPerRun), markiert sie mit bf=1 und macht beim naechsten Lauf weiter.
// Kostenlos auf GitHub Actions, kein Apify.
import fs from 'node:fs';

const cfg = {
  backfillPerRun: 100,
  backfillDelayMs: 3000,
  backfillMaxMinutes: 40,
  backfillMinRating: 75,
  ...JSON.parse(fs.readFileSync('config.json', 'utf8')),
};
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRIPT_VERSION = 2;
const RELEASE = Date.UTC(2026, 8, 1); // Zeitstempel vor September 2026 sind nicht plausibel

const FILES = { fast: 'prices.json', slow: 'prices-low.json' };
const dbs = {};
for (const [k, f] of Object.entries(FILES)) {
  try { dbs[k] = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { dbs[k] = { updated: null, cards: {} }; }
  dbs[k].cards = dbs[k].cards || {};
}

// ---------- Reihen in beliebigem JSON finden ----------
export function toPoint(x) {
  let t, p;
  if (Array.isArray(x) && x.length >= 2 && (typeof x[0] === 'number' || typeof x[0] === 'string') && typeof x[1] === 'number') {
    t = typeof x[0] === 'string' ? Date.parse(x[0]) : x[0]; p = x[1];
  } else if (x && typeof x === 'object' && !Array.isArray(x)) {
    for (const [k, v] of Object.entries(x)) {
      if (/date|time|^ts$|stamp|created|^x$/i.test(k)) t = typeof v === 'number' ? v : Date.parse(v);
      else if (/price|value|bin|coins|^p$|^y$/i.test(k) && typeof v === 'number') p = v;
    }
  }
  if (!(t > 0) || !(p > 0)) return null;
  if (t < 1e11) t *= 1000; // Sekunden -> Millisekunden
  if (t < RELEASE || t > Date.now() + 864e5) return null;
  return [Math.round(t), Math.round(p)];
}
export function extractSeries(node, out = []) {
  if (Array.isArray(node)) {
    if (node.length >= 5) {
      const pts = node.map(toPoint).filter(Boolean);
      if (pts.length >= node.length * 0.8) out.push(pts);
    }
    for (const x of node) if (x && typeof x === 'object') extractSeries(x, out);
  } else if (node && typeof node === 'object') {
    // parallele Arrays: {timestamps:[...], prices:[...]}
    const ak = Object.keys(node).filter((k) => Array.isArray(node[k]) && node[k].length >= 5);
    for (const ka of ak) for (const kb of ak) {
      if (ka === kb || node[ka].length !== node[kb].length) continue;
      if (/time|date|stamp|labels|^x$|^ts$/i.test(ka) && /price|value|^y$|data|coins|bin/i.test(kb)) {
        const pts = node[ka].map((t, i) => toPoint([t, node[kb][i]])).filter(Boolean);
        if (pts.length >= node[ka].length * 0.8) out.push(pts);
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') extractSeries(v, out);
  }
  return out;
}
// Pfade im JSON, deren Schluessel nach Preis oder Historie klingen (nur fuer die Diagnose)
export function findPaths(node, re, path = '$', out = [], depth = 0) {
  if (out.length >= 10 || depth > 8 || !node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    const p = Array.isArray(node) ? path + '[]' : path + '.' + k;
    if (!Array.isArray(node) && re.test(k)) out.push(p + (Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' ? '{}' : `=${String(v).slice(0, 20)}`));
    if (v && typeof v === 'object' && !(Array.isArray(node) && +k > 0)) findPaths(v, re, p, out, depth + 1);
  }
  return out;
}

// ---------- Kandidaten waehlen ----------
const cand = [];
for (const [set, db] of Object.entries(dbs)) {
  for (const [id, e] of Object.entries(db.cards)) {
    if ((e.bf === 1 || (e.bf === 2 && e.bfv === SCRIPT_VERSION)) || !e.url || (e.rating || 0) < cfg.backfillMinRating) continue;
    cand.push({ set, id, e, price: e.h.length ? e.h[e.h.length - 1][1] : 0 });
  }
}
cand.sort((a, b) => (b.e.rating - a.e.rating) || (b.price - a.price));
const todo = cand.slice(0, cfg.backfillPerRun);
console.log(`Backfill: ${cand.length} Karten offen, ${todo.length} in diesem Lauf.`);
if (!todo.length) { console.log('Nichts zu tun.'); process.exit(0); }

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

async function grab(url, debug) {
  const page = await ctx.newPage();
  const seen = [];
  const bodies = [];
  page.on('response', (r) => {
    try {
      const rt = r.request().resourceType();
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      const u = r.url();
      if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf|css|js|mjs|map)(\?|$)/i.test(u)) return;
      if (!(rt === 'xhr' || rt === 'fetch' || ct.includes('json') || /price|history|chart|market|graph/i.test(u))) return;
      seen.push({ u, status: r.status(), rt, ct: ct.split(';')[0] });
      bodies.push(r.text().then((t) => ({ u, t })).catch(() => null));
    } catch {}
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    // Seite scrollen (Diagramme laden oft erst, wenn sie sichtbar werden)
    for (const f of [0.3, 0.6, 1]) {
      try { await page.evaluate((x) => window.scrollTo(0, document.body.scrollHeight * x), f); } catch {}
      await page.waitForTimeout(1200);
    }
    // Zeitraum-Schalter anklicken, damit auch lange Reihen nachgeladen werden
    for (const re of [/^all( time)?$/i, /^max$/i, /^season$/i, /^(1 ?m|month)$/i, /^(1 ?w|week)$/i]) {
      try {
        const el = page.locator('button,a,[role=tab],li').filter({ hasText: re }).first();
        if (await el.count()) { await el.click({ timeout: 1500 }); await page.waitForTimeout(1500); }
      } catch {}
    }
    await page.waitForTimeout(1500);

    const docs = [];
    for (const g of (await Promise.all(bodies)).filter(Boolean)) {
      try { docs.push({ src: g.u, j: JSON.parse(g.t) }); } catch {}
    }
    // JSON, das fest in der Seite steckt (z. B. __NEXT_DATA__ oder andere Skript-Daten)
    let scripts = [];
    try {
      scripts = await page.evaluate(() => [...document.scripts].map((s) => ({ id: s.id, type: s.type, text: s.textContent || '' })).filter((s) => s.text.length > 200).map((s) => ({ id: s.id, type: s.type, text: s.text.slice(0, 3000000) })));
    } catch {}
    for (const sc of scripts) {
      let j = null;
      try { j = JSON.parse(sc.text); } catch {
        const i0 = Math.min(...['{', '['].map((c) => { const k = sc.text.indexOf(c); return k < 0 ? 1e12 : k; }));
        const i1 = Math.max(sc.text.lastIndexOf('}'), sc.text.lastIndexOf(']'));
        if (i0 < 1e12 && i1 > i0) { try { j = JSON.parse(sc.text.slice(i0, i1 + 1)); } catch {} }
      }
      if (j) docs.push({ src: 'Skript ' + (sc.id || sc.type || '?'), j });
    }

    let best = [];
    for (const d of docs) for (const sr of extractSeries(d.j)) if (sr.length > best.length) best = sr;

    if (debug) {
      console.log(`  XHR/Fetch-Antworten (${seen.length}):`);
      for (const x of seen.slice(0, 25)) console.log(`   - ${x.status} ${x.rt} ${x.ct || '-'} ${x.u.slice(0, 150)}`);
      console.log(`  Seiten-Skripte mit Daten: ${scripts.map((x) => (x.id || x.type || 'inline') + ':' + x.text.length).join(', ') || '(keine)'}`);
      const paths = [];
      for (const d of docs) for (const pth of findPaths(d.j, /price|history|chart|series|graph/i)) paths.push(`${d.src.slice(-40)} ${pth}`);
      console.log('  Pfade mit price/history:', paths.slice(0, 12).join(' | ') || '(keine)');
      console.log('  Reihe gefunden:', best.length, best.length ? `${new Date(best[0][0]).toISOString()} .. ${new Date(best[best.length - 1][0]).toISOString()}` : '-');
    }
    return best;
  } catch (e) {
    if (debug) console.log('  Fehler:', String(e.message).split('\n')[0]);
    return [];
  } finally {
    await page.close();
  }
}

let ok = 0, none = 0, i = 0;
for (const c of todo) {
  if ((Date.now() - startedAt) / 60000 > cfg.backfillMaxMinutes) { console.log('Zeitlimit erreicht.'); break; }
  const debug = i++ < 3;
  if (debug) console.log(`Karte ${c.e.name} (${c.e.rating}) ${c.e.url}`);
  const series = await grab(c.e.url, debug);
  if (series.length >= 5) {
    // nur Punkte VOR dem ersten eigenen Messpunkt uebernehmen, dann ausduennen (aelter als 3 Tage: alle 4 Stunden)
    const first = c.e.h.length ? c.e.h[0][0] : Date.now();
    const old = series.filter((x) => x[0] < first).sort((a, b) => a[0] - b[0]);
    const thinned = [];
    let last = 0;
    for (const x of old) {
      if (x[0] >= Date.now() - 3 * 864e5 || x[0] - last >= 4 * 36e5) { thinned.push(x); last = x[0]; }
    }
    c.e.h = thinned.concat(c.e.h);
    c.e.bf = 1; c.e.bfv = SCRIPT_VERSION; ok++;
  } else {
    c.e.bf = 2; c.e.bfv = SCRIPT_VERSION; none++; // keine Reihe gefunden
  }
  await sleep(cfg.backfillDelayMs + Math.random() * 1500);
}
await browser.close();

for (const [set, db] of Object.entries(dbs)) {
  db.updated = db.updated || new Date().toISOString();
  fs.writeFileSync(FILES[set], JSON.stringify(db));
}
console.log(`Backfill fertig: ${ok} Karten mit Historie, ${none} ohne gefundene Reihe.`);
if (ok === 0 && todo.length >= 3) { console.error('Keine einzige Historie gefunden - Format pruefen (siehe JSON-Antworten oben).'); process.exit(1); }
