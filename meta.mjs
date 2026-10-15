// Chemie-Daten (Verein, Liga, Nation, Position und Alternativpositionen) fuer die Karten des Katalogs.
// Quelle 1: FUT.GG-Datenschnittstelle (im Browser abgerufen). Quelle 2: EA-Ratingseite des Spielers (Nation, Liga, Verein, Position).
// Jeder Lauf bearbeitet einen Teil der Spieler (metaPerRun) und macht beim naechsten Mal weiter. Kostenlos, kein Apify.
import fs from 'node:fs';

const cfg = { metaPerRun: 60, metaMaxMinutes: 4, metaDelayMs: 1200, ...JSON.parse(fs.readFileSync('config.json', 'utf8')) };
const DIR = process.env.DATA_DIR || '.';
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let catalog = { cards: {} }, meta = { players: {} };
try { catalog = JSON.parse(fs.readFileSync(`${DIR}/catalog.json`, 'utf8')); } catch {}
try { meta = JSON.parse(fs.readFileSync(`${DIR}/players-meta.json`, 'utf8')); } catch {}
meta.players = meta.players || {};

// ---- Spieler (EA-ID) aus dem Katalog ----
const wanted = new Map();
for (const c of Object.values(catalog.cards)) {
  const m = (c.url || '').match(/\/players\/(\d+)-([^/]+)\//);
  if (!m) continue;
  const w = wanted.get(m[1]) || { slug: m[2], rating: 0 };
  w.rating = Math.max(w.rating, c.rating);
  wanted.set(m[1], w);
}
const todo = [...wanted.entries()].filter(([id]) => !meta.players[id] || meta.players[id].retry < 3 && !meta.players[id].nat).sort((a, b) => b[1].rating - a[1].rating).slice(0, cfg.metaPerRun);
console.log(`Meta: ${wanted.size} Spieler im Katalog, ${Object.keys(meta.players).length} mit Daten, ${todo.length} in diesem Lauf.`);
if (!todo.length) { console.log('Nichts zu tun.'); process.exit(0); }

// ---- Hilfen zum Auslesen unbekannter JSON-Formen ----
const walk = (n, f, d = 0) => { if (d > 12 || !n || typeof n !== 'object') return; f(n); for (const v of Object.values(n)) walk(v, f, d + 1); };
const asRef = (v) => {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return { id: v.id ?? v.eaId ?? v.value ?? null, name: v.name ?? v.label ?? v.shortName ?? v.abbreviation ?? v.shortLabel ?? null };
  return { id: v, name: null };
};
const posStr = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') return v.shortLabel || v.abbreviation || v.short || v.id || v.name || null;
  return String(v);
};
export function extractGG(json) {
  let best = null;
  walk(json, (o) => {
    if (Array.isArray(o)) return;
    const ov = o.overall ?? o.overallRating ?? o.rating;
    if (typeof ov === 'number' && ov >= 40 && ov <= 99 && ('position' in o || 'positionId' in o || 'preferredPosition1' in o)) {
      if (!best || ov > best.ov) best = { ov, o };
    }
  });
  if (!best) return null;
  const o = best.o;
  const altRaw = o.alternativePositions ?? o.alternatePositions ?? o.altPositions ?? o.alternativePositionIds ?? o.alternatePositionIds ?? [o.preferredPosition2, o.preferredPosition3].filter((x) => x != null);
  return {
    nat: asRef(o.nation ?? o.nationality ?? o.country ?? (o.nationId != null ? { id: o.nationId } : null)),
    lg: asRef(o.league ?? (o.leagueId != null ? { id: o.leagueId } : null)),
    club: asRef(o.club ?? o.team ?? (o.clubId != null ? { id: o.clubId } : o.teamId != null ? { id: o.teamId } : null)),
    pos: posStr(o.position ?? o.positionId ?? o.preferredPosition1),
    alt: (Array.isArray(altRaw) ? altRaw : []).map(posStr).filter(Boolean),
    woman: o.isWoman ?? o.female ?? (o.gender && (o.gender.id === 1 || /female|women/i.test(o.gender.label || ''))) ?? undefined,
  };
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'en-US', viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});
const gg = await ctx.newPage();
try { await gg.goto('https://www.fut.gg/', { waitUntil: 'domcontentloaded', timeout: 45000 }); await gg.waitForTimeout(2500); } catch (e) { console.error('FUT.GG nicht erreichbar:', String(e.message).split('\n')[0]); }
const ea = await ctx.newPage();

async function fromGG(id) {
  try {
    const r = await gg.evaluate(async (i) => { const res = await fetch(`/api/fut/players/v2/all-versions/${i}/`, { credentials: 'include' }); return { s: res.status, t: await res.text() }; }, id);
    if (r.s !== 200) return { status: r.s };
    let j; try { j = JSON.parse(r.t); } catch { return { status: r.s, bad: r.t.slice(0, 120) }; }
    return { status: r.s, json: j, data: extractGG(j) };
  } catch (e) { return { error: String(e.message).split('\n')[0] }; }
}
async function fromEA(id, slug) {
  for (const sl of [slug, 'player']) {
    try {
      const resp = await ea.goto(`https://www.ea.com/games/ea-sports-fc/ratings/player-ratings/${sl}/${id}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      if (resp && resp.status() >= 400) continue;
      await ea.waitForTimeout(1500);
      const d = await ea.evaluate(() => {
        const t = document.body.innerText, g = (re) => { const m = t.match(re); return m ? m[1].trim() : ''; };
        const idOf = (sel) => { const a = document.querySelector(sel); const m = a && a.href.match(/\/(\d+)\/?$/); return m ? m[1] : null; };
        return { pos: g(/\nPosition\n+([A-Z]{2,3})\b/), nation: g(/\nNation\n+([^\n]+)/), league: g(/\nLeague\n+([^\n]+)/), team: g(/\nTeam\n+([^\n]+)/), nid: idOf('a[href*="/nations-ratings/"]'), cid: idOf('a[href*="/teams-ratings/"]') };
      });
      if (d.nation || d.team) return d;
    } catch {}
  }
  return null;
}

let ok = 0, n = 0, dbg = 0;
for (const [id, w] of todo) {
  if ((Date.now() - startedAt) / 60000 > cfg.metaMaxMinutes) { console.log('Zeitlimit erreicht.'); break; }
  const g = await fromGG(id);
  const e = await fromEA(id, w.slug);
  const rec = meta.players[id] || { retry: 0 };
  const d = g.data || {};
  const nat = (d.nat && (d.nat.id != null || d.nat.name)) ? d.nat : (e ? { id: e.nid, name: e.nation } : null);
  const lg = (d.lg && (d.lg.id != null || d.lg.name)) ? d.lg : (e && e.league ? { id: e.league.toLowerCase(), name: e.league } : null);
  const club = (d.club && (d.club.id != null || d.club.name)) ? d.club : (e ? { id: e.cid, name: e.team } : null);
  if (d.nat && !d.nat.name && e && e.nation) nat.name = e.nation;
  if (d.club && !d.club.name && e && e.team) club.name = e.team;
  if (d.lg && !d.lg.name && e && e.league) lg.name = e.league;
  Object.assign(rec, { nat, lg, club, pos: d.pos || (e && e.pos) || rec.pos || null, alt: d.alt && d.alt.length ? d.alt : rec.alt || [], src: g.data ? (e ? 'gg+ea' : 'gg') : e ? 'ea' : null });
  if (d.woman !== undefined) rec.woman = !!d.woman;
  if (!nat) rec.retry = (rec.retry || 0) + 1;
  meta.players[id] = rec;
  n++; if (nat) ok++;
  if (dbg < 2) {
    dbg++;
    console.log(`--- Debug Spieler ${id} (${w.slug})`);
    console.log('FUT.GG-API: Status', g.status ?? g.error ?? '-', g.json ? 'Schluessel: ' + Object.keys(g.json).join(',') : '', g.bad ? 'Antwort: ' + g.bad : '');
    if (g.json) console.log('  Beispiel:', JSON.stringify(g.json).slice(0, 500));
    console.log('  Erkannt (GG):', JSON.stringify(g.data || null));
    console.log('EA-Seite:', JSON.stringify(e));
  }
  await sleep(cfg.metaDelayMs);
}
await browser.close();
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(`${DIR}/players-meta.json`, JSON.stringify({ updated: new Date().toISOString(), players: meta.players }));
const all = Object.values(meta.players);
console.log(`Meta fertig: ${n} bearbeitet, ${ok} mit Nation/Liga/Verein. Gesamt: ${all.length}/${wanted.size} Spieler, davon mit Alternativpositionen: ${all.filter((p) => p.alt && p.alt.length).length}.`);
