// Sammelt Markt-Ereignisse aus offiziellen Quellen:
//  1) Aktuell LAUFENDE SBCs (so wie sie im Spiel verfuegbar sind) von FUT.GG
//  2) Offizielle Meldungen von EA (ea.com Newsseite) - z. B. Pitch Notes, Promo-Ankuendigungen
// Keine Geruechte, keine Prognosen. Kostenlos auf GitHub Actions (Playwright), kein Apify.
import fs from 'node:fs';

const now = Date.now();
let prev = { sbcs: [], news: [] };
try { prev = JSON.parse(fs.readFileSync('events.json', 'utf8')); } catch {}
const firstSeen = (list, key, v) => (list.find((x) => x[key] === v) || {}).first || now;

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

const UNIT = { minute: 6e4, hour: 36e5, day: 864e5 };
export function parseExpiry(text) {
  const m = String(text).match(/Expires\s*in\s*(\d+)\s*(minute|hour|day|year)s?/i);
  if (!m) return { at: null, text: '' };
  const n = +m[1], u = m[2].toLowerCase();
  if (u === 'year') return { at: null, text: `${n} Jahre (dauerhaft)` };
  return { at: now + n * UNIT[u], text: `${n} ${u}${n > 1 ? 's' : ''}` };
}

async function sbcPage(url) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="/sbc/"][href*="/27-"]', { timeout: 25000 });
    await page.waitForTimeout(2000);
    return await page.evaluate(() => {
      const re = /\/sbc\/([a-z-]+)\/27-(\d+)-/;
      const links = [...document.querySelectorAll('a[href*="/sbc/"]')].filter((a) => re.test(a.href));
      const byId = new Map();
      for (const a of links) { const id = a.href.match(re)[2]; if (!byId.has(id)) byId.set(id, a); }
      const out = [];
      for (const [id, a] of byId) {
        const href = a.href;
        let box = a;
        while (box.parentElement && box.parentElement !== document.body) {
          const ids = new Set([...box.parentElement.querySelectorAll('a[href*="/sbc/"]')].filter((x) => re.test(x.href)).map((x) => x.href.match(re)[2]));
          if (ids.size !== 1) break;
          box = box.parentElement;
        }
        const text = box.innerText || '';
        const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
        const h = box.querySelector('h1,h2,h3,h4');
        out.push({
          id, url: href, type: href.match(re)[1],
          name: (h ? h.innerText : '').trim(),
          cost: (lines.find((l) => /^[\d,]{3,}$/.test(l)) || '').replace(/,/g, ''),
          reward: lines.find((l) => /^(Earn|Complete|Exchange|Submit)\b/i.test(l)) || '',
          repeatable: (text.match(/Repeatable\s*([^\n]+)/i) || [, ''])[1].trim(),
          text: text.replace(/\s+/g, ' ').slice(0, 600),
        });
      }
      return out;
    });
  } catch (e) {
    console.error('SBC-Seite fehlgeschlagen:', url, String(e.message).split('\n')[0]);
    return [];
  } finally {
    await page.close();
  }
}

let sbcs = [];
for (const url of ['https://www.fut.gg/sbc/', 'https://www.fut.gg/sbc/?page=2']) {
  const part = await sbcPage(url);
  console.log(`SBC-Seite ${url}: ${part.length} SBCs`);
  if (!part.length && url.endsWith('/sbc/')) break;
  sbcs.push(...part);
  await new Promise((r) => setTimeout(r, 3000));
}
const seenIds = new Set();
sbcs = sbcs.filter((s) => (seenIds.has(s.id) ? false : seenIds.add(s.id))).map((s) => {
  const ex = parseExpiry(s.text);
  return {
    id: s.id, name: s.name || s.url.split('/').filter(Boolean).pop().replace(/^27-\d+-/, '').replace(/-/g, ' '),
    type: s.type, cost: s.cost ? +s.cost : null, reward: s.reward, repeatable: s.repeatable,
    expiresAt: ex.at, expiresText: ex.text, url: s.url, first: firstSeen(prev.sbcs, 'id', s.id),
  };
});

// ---------- Offizielle EA-Meldungen ----------
let news = [];
{
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.ea.com/games/ea-sports-fc/fc-27/news', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    news = await page.evaluate(() => {
      const out = [], seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/news/"]')) {
        const title = (a.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s.length > 12)[0] || '';
        if (!title || seen.has(a.href) || /\/news\/?$/.test(a.href)) continue;
        seen.add(a.href);
        out.push({ title, url: a.href });
      }
      return out.slice(0, 25);
    });
  } catch (e) {
    console.error('EA-News fehlgeschlagen:', String(e.message).split('\n')[0]);
  } finally {
    await page.close();
  }
}
const FLAG = /totw|team of the week|hero|icon|promo|sbc|squad building|pack|roadmap|pitch notes|ultimate team|season|objective|evolution/i;
news = news.map((n) => ({ ...n, first: firstSeen(prev.news, 'url', n.url), flag: FLAG.test(n.title) }));
console.log(`EA-News: ${news.length} Meldungen`);
await browser.close();

if (!sbcs.length && !news.length) { console.error('Keine Ereignisse gefunden, events.json bleibt unveraendert.'); process.exit(1); }
fs.writeFileSync('events.json', JSON.stringify({ updated: new Date(now).toISOString(), sbcs, news }));
console.log(`Fertig: ${sbcs.length} SBCs, ${news.length} EA-Meldungen.`);
