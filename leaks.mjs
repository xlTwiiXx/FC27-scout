// Liest oeffentliche Beitraege bestimmter X-Konten (Leaker) ueber den oeffentlichen Embed-Zeitstrahl von X
// und schreibt sie nach leaks.json. Kostenlos auf GitHub Actions, kein Apify, kein X-Konto.
// Hinweis: Das sind INOFFIZIELLE Meldungen. X kann den Zugriff jederzeit begrenzen oder sperren.
import fs from 'node:fs';

const cfg = {
  leakAccounts: ['FUTPOLICE', 'FutSheriff', 'DetectiveFUT', 'FUTxGG'],
  leakKeepDays: 21,
  leakMaxPerAccount: 80,
  leakDelayMs: 4000,
  newsQueries: ['FC 27 leak', 'FC 27 SBC leak', 'FC 27 promo leak', 'FC 27 TOTW', 'FC 27 Ultimate Team Hero Icon'],
  newsMax: 25,
  ...JSON.parse(fs.readFileSync('config.json', 'utf8')),
};
const now = Date.now();
let prev = { tweets: [] };
try { prev = JSON.parse(fs.readFileSync('leaks.json', 'utf8')); } catch {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAGS = [
  ['SBC', /\bsbcs?\b|squad building|streamlined/i],
  ['Promo', /promo|totw|toty|tots|potm|futties|fantasy|flashback|showdown|rttf|ttf|future stars|wildcard|champions|rivals/i],
  ['Icon/Hero', /\bicons?\b|\bheroes?\b|\bheroe?s?\b/i],
  ['Pack', /\bpacks?\b|\bpick\b|\bswaps?\b/i],
  ['Evo', /\bevo(lution)?s?\b/i],
  ['Objective', /objective|season track|token/i],
  ['Markt', /market|price|invest|sell|buy|crash|rise|\bcoins?\b|fodder|trade/i],
];
const PRED = /predict|prediction|speculat|rumou?r|my guess|my take|expect|could be|might be|\bif\b.*\bthen\b/i;

export function cleanText(s) {
  return String(s || '').replace(/https:\/\/t\.co\/\w+/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+\n/g, '\n').trim();
}
export function collectTweets(node, out = []) {
  if (Array.isArray(node)) { for (const x of node) collectTweets(x, out); }
  else if (node && typeof node === 'object') {
    if (node.id_str && (node.full_text || node.text) && node.created_at) out.push(node);
    for (const v of Object.values(node)) if (v && typeof v === 'object') collectTweets(v, out);
  }
  return out;
}
export function toLeak(raw, fallbackHandle) {
  const text = cleanText(raw.full_text || raw.text);
  if (!text || /^RT @/.test(text) || raw.in_reply_to_status_id_str || raw.retweeted_status) return null;
  const t = Date.parse(raw.created_at);
  if (!(t > 0)) return null;
  const handle = (raw.user && raw.user.screen_name) || fallbackHandle;
  const tags = TAGS.filter(([, re]) => re.test(text)).map(([n]) => n);
  return { id: raw.id_str, handle, name: (raw.user && raw.user.name) || handle, text: text.slice(0, 600), t,
    url: `https://x.com/${handle}/status/${raw.id_str}`, tags, pred: PRED.test(text) };
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, args: ['--disable-http2'] });
const ctx = await browser.newContext({
  locale: 'en-US',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

const accounts = {};
const fresh = [];
for (const handle of cfg.leakAccounts) {
  const info = { ok: false, n: 0, error: '' };
  accounts[handle] = info;
  const page = await ctx.newPage();
  try {
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?dnt=true&showReplies=false`;
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const status = resp ? resp.status() : 0;
    const raw = await page.evaluate(() => {
      const el = document.querySelector('#__NEXT_DATA__');
      return el ? el.textContent : '';
    });
    if (!raw) {
      const body = (await page.evaluate(() => document.body ? document.body.innerText : '')).replace(/\s+/g, ' ').slice(0, 200);
      info.error = `keine Daten (Status ${status}): ${body}`;
    } else {
      const tweets = collectTweets(JSON.parse(raw)).map((r) => toLeak(r, handle)).filter(Boolean);
      const seen = new Set();
      const uniq = tweets.filter((x) => (seen.has(x.id) ? false : seen.add(x.id)));
      info.ok = uniq.length > 0;
      info.n = uniq.length;
      if (!uniq.length) info.error = 'Seite geladen, aber keine Beitraege gefunden';
      fresh.push(...uniq);
    }
  } catch (e) {
    info.error = String(e.message).split('\n')[0];
  } finally {
    await page.close();
  }
  console.log(`@${handle}: ${info.ok ? info.n + ' Beitraege' : 'FEHLER - ' + info.error}`);
  await sleep(cfg.leakDelayMs + Math.random() * 1500);
}
await browser.close();

// ---------- Medien: Google News (oeffentlicher RSS-Feed, mit Zeitstempel) ----------
const decode = (x) => String(x || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
export function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const g = (tag) => { const x = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return x ? decode(x[1]) : ''; };
    items.push({ title: g('title'), link: g('link'), pub: g('pubDate'), source: g('source') });
  }
  return items;
}
const hash = (str) => { let h = 5381; for (const c of str) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const normT = (x) => x.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
{
  const info = { ok: false, n: 0, error: '' };
  accounts['Medien'] = info;
  const got = new Map();
  for (const q of cfg.newsQueries || []) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:3d')}&hl=en-US&gl=US&ceid=US:en`;
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      for (const it of parseRss(await r.text())) {
        const t = Date.parse(it.pub);
        if (!(t > 0) || !it.title) continue;
        let title = it.title;
        if (it.source && title.endsWith(' - ' + it.source)) title = title.slice(0, -(it.source.length + 3));
        if (!/fc ?27|ea sports fc|ultimate team|\bfut\b|totw|totS|toty|potm/i.test(title)) continue;
        const key = normT(title);
        if (got.has(key) && got.get(key).t >= t) continue;
        got.set(key, { id: 'n' + hash(key), kind: 'news', handle: it.source || 'Medien', name: it.source || 'Medien', text: title.slice(0, 400), t, url: it.link,
          tags: TAGS.filter(([, re]) => re.test(title)).map(([n]) => n), pred: PRED.test(title) });
      }
    } catch (e) { info.error = String(e.message).split('\n')[0]; }
    await sleep(800);
  }
  const list = [...got.values()].sort((a, b) => b.t - a.t).slice(0, cfg.newsMax || 25);
  info.ok = list.length > 0; info.n = list.length;
  if (!list.length && !info.error) info.error = 'keine Treffer';
  fresh.push(...list);
  console.log(`Medien (Google News): ${info.ok ? info.n + ' Artikel' : 'FEHLER - ' + info.error}`);
}

// Mit frueheren Beitraegen zusammenfuehren, damit auch Aelteres erhalten bleibt
const byId = new Map();
for (const x of [...(prev.tweets || []), ...fresh]) byId.set(x.id, x);
const cutoff = now - cfg.leakKeepDays * 864e5;
const perHandle = {};
const tweets = [...byId.values()]
  .filter((x) => x.t >= cutoff)
  .sort((a, b) => b.t - a.t)
  .filter((x) => (perHandle[x.handle] = (perHandle[x.handle] || 0) + 1) <= cfg.leakMaxPerAccount);

if (!fresh.length && !tweets.length) {
  console.error('Keine Leaks erhalten (X blockiert vermutlich den Zugriff). leaks.json bleibt unveraendert.');
  process.exit(1);
}
fs.writeFileSync('leaks.json', JSON.stringify({ updated: new Date(now).toISOString(), accounts, tweets }));
console.log(`Fertig: ${fresh.length} neue/aktuelle Beitraege gelesen, ${tweets.length} gespeichert.`);
