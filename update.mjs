// Holt Preise von FUT.GG (Listen nach Rating, sortiert nach Preis) ueber Apify
// und schreibt sie mit Zeitstempel in prices.json.
import fs from 'node:fs';

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) { console.error('APIFY_TOKEN fehlt (GitHub Secret).'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
let db = { updated: null, cards: {} };
try { db = JSON.parse(fs.readFileSync('prices.json', 'utf8')); } catch {}
db.cards = db.cards || {};

// "10.8K" -> 10800, "1.2M" -> 1200000, "850" -> 850, "EXTINCT" -> null
const num = (s) => {
  const m = String(s).replace(/,/g, '').match(/^([\d.]+)([KM]?)$/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1));
};

async function scrape(url) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(
        'https://api.apify.com/v2/acts/apify~rag-web-browser/run-sync-get-dataset-items?timeout=180',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
          body: JSON.stringify({
            query: url,
            maxResults: 1,
            outputFormats: ['markdown'],
            scrapingTool: 'browser-playwright',
            dynamicContentWaitSecs: 10,
          }),
          signal: AbortSignal.timeout(240000),
        }
      );
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const items = await r.json();
      return (items && items[0] && items[0].markdown) || '';
    } catch (e) {
      console.error('Versuch ' + (i + 1) + ' fehlgeschlagen:', e.message);
    }
  }
  return '';
}

// Ein Kartenblock in der Markdown-Ausgabe:
// [ ![Name - 88 - Rare](bild) POS 86.3 ![Coin](...)11K ... ](https://www.fut.gg/players/.../27-ID/)
const RE = /\[\s*!\[(.+?) - (\d{2}) - (.+?)\]\([^)]*\)\s*([A-Z]{2,3})\s*([\d.]+)\s*!\[Coin\]\([^)]*\)\s*([\d.,]+[KM]?|EXTINCT)[\s\S]*?\]\((https:\/\/www\.fut\.gg\/players\/[^)\s]+\/27-(\d+)\/)\)/g;

function parse(md) {
  const out = [];
  RE.lastIndex = 0;
  let m;
  while ((m = RE.exec(md))) {
    const price = num(m[6]);
    if (!price) continue; // EXTINCT oder unlesbar
    out.push({
      id: m[8], name: m[1].trim(), rating: +m[2], version: m[3].trim(),
      pos: m[4], gg: +m[5], price, url: m[7],
    });
  }
  return out;
}

const t = Date.now();
const cutoff = t - 14 * 864e5;
let total = 0;

for (const r of cfg.ratings) {
  for (let p = 1; p <= (cfg.pages || 1); p++) {
    const url = `https://www.fut.gg/players/?overall__gte=${r}&overall__lte=${r}&market_players=true&sorts=current_price` + (p > 1 ? `&page=${p}` : '');
    const cards = parse(await scrape(url));
    console.log(`Rating ${r} Seite ${p}: ${cards.length} Karten`);
    if (cards.length < 5) { console.error('Zu wenige Karten, Seite wird uebersprungen.'); continue; }
    for (const c of cards) {
      const e = db.cards[c.id] || { h: [] };
      Object.assign(e, { name: c.name, rating: c.rating, version: c.version, pos: c.pos, url: c.url });
      e.h.push([t, c.price]);
      e.h = e.h.filter((x) => x[0] >= cutoff);
      db.cards[c.id] = e;
    }
    total += cards.length;
  }
}

if (total === 0) { console.error('Keine Daten erhalten, prices.json bleibt unveraendert.'); process.exit(1); }

db.updated = new Date(t).toISOString();
fs.writeFileSync('prices.json', JSON.stringify(db));
console.log('Fertig:', total, 'Preise gespeichert.');
