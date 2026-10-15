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
  if (Array.isArray(x) && x.length >= 2 && typeof x[0] === 'number' && typeof x[1] === 'number') { t = x[0]; p = x[1]; }
  else if (x && typeof x === 'object' && !Array.isArray(x)) {
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
    for (const v of Object.values(node)) if (v && typeof v === 'object') extractSeries(v, out);
  }
  return out;
}

// ---------- Kandidaten waehlen ----------
const cand = [];
for (const [set, db] of Object.entries(dbs)) {
  for (const [id, e] of Object.entries(db.cards)) {
    if (e.bf || !e.url || (e.rating || 0) < cfg.backfillMinRating) continue;
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
  const bodies = [];
  const urls = [];
  page.on('response', (r) => {
    try {
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      urls.push(r.url());
      bodies.push(r.json().then((j) => ({ url: r.url(), j })).catch(() => null));
    } catch {}
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    // Zeitraum-Reiter anklicken, damit auch lange Reihen nachgeladen werden
    for (const label of ['All', 'All time', 'Season', 'Month', '1M', 'Max']) {
      try {
        const el = page.getByRole('button', { name: new RegExp('^' + label + '$', 'i') }).first();
        if (await el.count()) { await el.click({ timeout: 1500 }); await page.waitForTimeout(1500); }
      } catch {}
    }
    await page.waitForTimeout(1500);
    const got = (await Promise.all(bodies)).filter(Boolean);
    let best = [];
    for (const g of got) {
      for (const s of extractSeries(g.j)) if (s.length > best.length) best = s;
    }
    if (debug) {
      console.log('  JSON-Antworten:', [...new Set(urls)].slice(0, 15).join(' | ') || '(keine)');
      console.log('  Reihe gefunden:', best.length, best.length ? `${new Date(best[0][0]).toISOString()} .. ${new Date(best[best.length - 1][0]).toISOString()}` : '-');
      if (!best.length && got.length) console.log('  Beispiel:', JSON.stringify(got[0].j).slice(0, 300));
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
    c.e.bf = 1; ok++;
  } else {
    c.e.bf = 2; none++; // keine Reihe gefunden, nicht endlos wiederholen
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
