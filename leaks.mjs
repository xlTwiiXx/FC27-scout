// Liest oeffentliche Beitraege bestimmter X-Konten (Leaker) ueber den oeffentlichen Embed-Zeitstrahl von X
// und schreibt sie nach leaks.json. Kostenlos auf GitHub Actions, kein Apify, kein X-Konto.
// Hinweis: Das sind INOFFIZIELLE Meldungen. X kann den Zugriff jederzeit begrenzen oder sperren.
import fs from 'node:fs';

const cfg = {
  leakAccounts: ['Futdonk', 'FGZNews', 'FIFA22_INFO', 'WeaverFUT', 'FutSheriff', 'FutPoliceLeaks', 'Rickth21', 'fifa_romania', 'AsyFutTrader'],
  leakKeepDays: 14,
  leakMaxPerAccount: 80,
  leakDelayMs: 4000,
  ...JSON.parse(fs.readFileSync('config.json', 'utf8')),
};
const DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DIR, { recursive: true });
const now = Date.now();
let prev = { tweets: [] };
try { prev = JSON.parse(fs.readFileSync(`${DIR}/leaks.json`, 'utf8')); } catch {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAGS = [
  ['SBC', /\bsbcs?\b|squad building|streamlined/i],
  ['TOTW', /totw|team of the week/i],
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
  const mediaRaw = (raw.extended_entities && raw.extended_entities.media) || (raw.entities && raw.entities.media) || raw.mediaDetails || [];
  const media = [...mediaRaw.map((m) => m.media_url_https || m.media_url), ...((raw.photos || []).map((p) => p.url))].filter(Boolean).slice(0, 4);
  const avatar = raw.user && raw.user.profile_image_url_https ? raw.user.profile_image_url_https.replace('_normal.', '_200x200.') : '';
  return { id: raw.id_str, handle, name: (raw.user && raw.user.name) || handle, avatar, media, text: text.slice(0, 600), t,
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
const prevAcc = prev.accounts || {};
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
      const newest = uniq.slice().sort((a, b) => b.t - a.t).find((x) => x.avatar);
      if (newest) { info.avatar = newest.avatar; info.name = newest.name; }
    }
  } catch (e) {
    info.error = String(e.message).split('\n')[0];
  } finally {
    await page.close();
  }
  if (!info.avatar && prevAcc[handle]) { info.avatar = prevAcc[handle].avatar || ''; info.name = info.name || prevAcc[handle].name || ''; }
  console.log(`@${handle}: ${info.ok ? info.n + ' Beitraege' : 'FEHLER - ' + info.error}${info.ok ? ' | Profilbild: ' + (info.avatar ? 'ja' : 'nein') : ''}`);
  await sleep(cfg.leakDelayMs + Math.random() * 1500);
}
await browser.close();

// Mit frueheren Beitraegen zusammenfuehren, damit auch Aelteres erhalten bleibt
const byId = new Map();
const allowed = new Set((cfg.leakAccounts || []).map((x) => x.toLowerCase()));
for (const x of [...(prev.tweets || []), ...fresh]) {
  // nur Beitraege der eingestellten X-Konten behalten, Aelteres von anderen Quellen verwerfen
  if (x.kind === 'news' || !allowed.has(String(x.handle).toLowerCase())) continue;
  byId.set(x.id, x);
}
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
fs.writeFileSync(`${DIR}/leaks.json`, JSON.stringify({ updated: new Date(now).toISOString(), accounts, tweets }));
console.log(`Beitraege mit Bild: ${fresh.filter((x) => x.media && x.media.length).length} von ${fresh.length}`);
console.log(`Fertig: ${fresh.length} neue/aktuelle Beitraege gelesen, ${tweets.length} gespeichert.`);
