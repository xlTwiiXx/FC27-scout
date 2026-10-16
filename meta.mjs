// Chemie-Daten (Verein, Liga, Nation, Position und Alternativpositionen) fuer die Karten des Katalogs.
// Quelle 1: FUT.GG-Datenschnittstelle (im Browser abgerufen). Quelle 2: EA-Ratingseite des Spielers (Nation, Liga, Verein, Position).
// Jeder Lauf bearbeitet einen Teil der Spieler (metaPerRun) und macht beim naechsten Mal weiter. Kostenlos, kein Apify.
import fs from 'node:fs';

const cfg = { metaPerRun: 400, metaMaxMinutes: 14, metaDelayMs: 500, metaConcurrency: 4, ...JSON.parse(fs.readFileSync('config.json', 'utf8')) };
const DIR = process.env.DATA_DIR || '.';
const startedAt = Date.now();
const maxMin = process.env.META_MAX_SECONDS ? Number(process.env.META_MAX_SECONDS) / 60 : cfg.metaMaxMinutes;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let catalog = { cards: {} }, meta = { players: {} };
try { catalog = JSON.parse(fs.readFileSync(`${DIR}/catalog.json`, 'utf8')); } catch {}
try { meta = JSON.parse(fs.readFileSync(`${DIR}/players-meta.json`, 'utf8')); } catch {}
meta.players = meta.players || {};
meta.items = meta.items || {};

// ---- Spieler (EA-ID) aus dem Katalog ----
const wanted = new Map();
for (const c of Object.values(catalog.cards)) {
  const m = (c.url || '').match(/\/players\/(\d+)-([^/]+)\//);
  if (!m) continue;
  const w = wanted.get(m[1]) || { slug: m[2], rating: 0 };
  w.rating = Math.max(w.rating, c.rating);
  wanted.set(m[1], w);
}
const todo = [...wanted.entries()].filter(([id]) => { const r = meta.players[id]; return !r || (r.v !== 3 && (r.retry || 0) < 3) || (!r.nat && (r.retry || 0) < 3); }).sort((a, b) => b[1].rating - a[1].rating).slice(0, cfg.metaPerRun);
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
// EA-Positions-IDs: 0 GK, 2 RWB, 3 RB, 4-6 CB, 7 LB, 8 LWB, 9-11 CDM, 12 RM, 13-15 CM, 16 LM, 17-19 CAM, 20-22 CF, 23 RW, 24-26 ST, 27 LW
const POSMAP = { 0: 'GK', 2: 'RWB', 3: 'RB', 4: 'CB', 5: 'CB', 6: 'CB', 7: 'LB', 8: 'LWB', 9: 'CDM', 10: 'CDM', 11: 'CDM', 12: 'RM', 13: 'CM', 14: 'CM', 15: 'CM', 16: 'LM', 17: 'CAM', 18: 'CAM', 19: 'CAM', 20: 'CF', 21: 'CF', 22: 'CF', 23: 'RW', 24: 'ST', 25: 'ST', 26: 'ST', 27: 'LW' };
const toPos = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') v = v.shortLabel || v.abbreviation || v.short || v.id || v.name;
  const s = String(v);
  return /^\d+$/.test(s) ? POSMAP[+s] || null : s.toUpperCase();
};
// Alle Karten des Spielers aus dem aktuellen Spiel (FC 27). Aeltere Spiele (FIFA 22, 23 ...) stehen in derselben Antwort und werden ignoriert.
export function extractItems(json) {
  const out = [];
  walk(json, (o) => {
    if (Array.isArray(o) || o.eaId == null || String(o.game) !== '27') return;
    const ov = o.overall ?? o.overallRating ?? o.rating;
    if (typeof ov !== 'number') return;
    const altRaw = o.alternativePositions ?? o.alternatePositions ?? o.altPositions ?? o.alternativePositionIds ?? o.alternatePositionIds ?? [o.preferredPosition2, o.preferredPosition3].filter((x) => x != null);
    const pos = toPos(o.position ?? o.positionId ?? o.preferredPosition1);
    out.push({
      id: String(o.eaId), ov, pos,
      alt: [...new Set((Array.isArray(altRaw) ? altRaw : []).map(toPos).filter((x) => x && x !== pos))],
      nat: asRef(o.nation ?? o.nationality ?? o.country ?? (o.nationId != null ? { id: o.nationId } : null)),
      lg: asRef(o.league ?? (o.leagueId != null ? { id: o.leagueId } : null)),
      club: asRef(o.club ?? o.team ?? (o.clubId != null ? { id: o.clubId } : o.teamId != null ? { id: o.teamId } : null)),
      keys: Object.keys(o).join(','),
    });
  });
  return out;
}
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

async function fromGG(id) {
  try {
    const r = await gg.evaluate(async (i) => { const res = await fetch(`/api/fut/players/v2/all-versions/${i}/`, { credentials: 'include' }); return { s: res.status, t: await res.text() }; }, id);
    if (r.s !== 200) return { status: r.s };
    let j; try { j = JSON.parse(r.t); } catch { return { status: r.s, bad: r.t.slice(0, 120) }; }
    return { status: r.s, json: j, data: extractGG(j) };
  } catch (e) { return { error: String(e.message).split('\n')[0] }; }
}
async function fromEA(ea, id, slug) {
  for (const sl of [slug, 'player']) {
    try {
      const resp = await ea.goto(`https://www.ea.com/games/ea-sports-fc/ratings/player-ratings/${sl}/${id}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      if (resp && resp.status() >= 400) continue;
      await ea.waitForTimeout(1500);
      const d = await ea.evaluate(() => {
        const t = document.body.innerText, g = (re) => { const m = t.match(re); return m ? m[1].trim() : ''; };
        const idOf = (sel) => { const a = document.querySelector(sel); const m = a && a.href.match(/\/(\d+)\/?$/); return m ? m[1] : null; };
        // Alternativpositionen: alles Gueltige direkt nach "Alt Positions", egal ob in Zeilen oder in einer Zeile
        const POS = new Set(['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST', 'CF', 'LF', 'RF', 'LS', 'RS']);
        const ma = t.match(/Alt(?:ernative)?\.? Positions?\s*/i);
        const alt = [];
        if (ma) for (const tok of t.slice(ma.index + ma[0].length, ma.index + ma[0].length + 100).split(/\s+/).filter(Boolean)) { if (POS.has(tok)) { if (!alt.includes(tok)) alt.push(tok); } else break; }
        return { pos: g(/\nPosition\n+([A-Z]{2,3})\b/), alt, nation: g(/\nNation\n+([^\n]+)/), league: g(/\nLeague\n+([^\n]+)/), team: g(/\nTeam\n+([^\n]+)/), nid: idOf('a[href*="/nations-ratings/"]'), cid: idOf('a[href*="/teams-ratings/"]') };
      });
      if (d.nation || d.team) return d;
    } catch {}
  }
  return null;
}

let ok = 0, n = 0, dbg = 0, next = 0;
async function worker() {
  const ea = await ctx.newPage();
  while (next < todo.length) {
    if ((Date.now() - startedAt) / 60000 > maxMin) { break; }
    const [id, w] = todo[next++];
    const g = await fromGG(id);
    const its = g.json ? extractItems(g.json) : [];
    let e = null;
    const rec = meta.players[id] || { retry: 0 };
    if (its.length) {
      const base = its.find((x) => x.id === String(id)) || its[0];
      Object.assign(rec, { nat: base.nat, lg: base.lg, club: base.club, pos: base.pos, alt: base.alt, v: 3, src: 'gg', n27: its.length });
      for (const x of its) meta.items[x.id] = { nat: x.nat, lg: x.lg, club: x.club, pos: x.pos, alt: x.alt };
    } else {
      // Ersatz: EA-Ratingseite (nur Gold, Silber, Bronze zum Start des Spiels)
      e = await fromEA(ea, id, w.slug);
      if (e) Object.assign(rec, { nat: e.nation ? { id: e.nid, name: e.nation } : null, lg: e.league ? { id: e.league.toLowerCase(), name: e.league } : null, club: e.team ? { id: e.cid, name: e.team } : null, pos: e.pos || null, alt: e.alt || [], v: 3, src: 'ea' });
    }
    const nat = rec.nat;
    if (!nat) rec.retry = (rec.retry || 0) + 1;
    meta.players[id] = rec;
    n++; if (nat) ok++;
    if (dbg < 2) {
      dbg++;
      console.log(`--- Debug Spieler ${id} (${w.slug})`);
      console.log('FUT.GG-API: Status', g.status ?? g.error ?? '-', g.json ? 'Schluessel: ' + Object.keys(g.json).join(',') : '', g.bad ? 'Antwort: ' + g.bad : '');
      console.log(`  FC-27-Karten im Ergebnis: ${its.length}${its[0] ? ' | Felder: ' + its[0].keys.slice(0, 400) : ''}`);
      console.log('  Datensatz:', JSON.stringify({ nat: rec.nat, lg: rec.lg, club: rec.club, pos: rec.pos, alt: rec.alt, src: rec.src }));
    }
    await sleep(cfg.metaDelayMs);
  }
  await ea.close();
}
await Promise.all(Array.from({ length: cfg.metaConcurrency }, worker));
await browser.close();
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(`${DIR}/players-meta.json`, JSON.stringify({ updated: new Date().toISOString(), players: meta.players, items: meta.items }));
const all = Object.values(meta.players);
console.log(`Meta fertig: ${n} bearbeitet, ${ok} mit Nation/Liga/Verein. Gesamt: ${all.length}/${wanted.size} Spieler, davon mit Alternativpositionen: ${all.filter((p) => p.alt && p.alt.length).length}.`);
