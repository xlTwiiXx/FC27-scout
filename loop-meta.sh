#!/usr/bin/env bash
# Eigener Dauerlauf fuer den Katalog aller Karten ab 75 und die Chemie-Daten (Verein, Liga, Nation, Positionen, Alternativpositionen).
# Laeuft getrennt vom Preis-Lauf und speichert in den Branch "data-meta", damit sich beide nicht in die Quere kommen.
set -u
DATA_DIR="${DATA_DIR:-datameta}"
BRANCH="${BRANCH:-data-meta}"
LOOP_SECONDS="${LOOP_SECONDS:-20100}"   # ca. 5,6 Stunden, danach startet sich der Lauf neu
REMOTE_URL="${REMOTE_URL:-https://x-access-token:${GH_TOKEN:-}@github.com/${GITHUB_REPOSITORY:-}.git}"
END=$(( $(date +%s) + LOOP_SECONDS ))
export DATA_DIR

save() {
  (
    cd "$DATA_DIR" || exit 1
    [ -f players-meta.json ] || [ -f catalog.json ] || exit 0
    rm -rf .git
    git init -q -b "$BRANCH"
    git config user.name "scout-bot"
    git config user.email "scout-bot@users.noreply.github.com"
    git add -A
    git commit -q -m "Daten $(date -u +%FT%TZ)"
    git remote add origin "$REMOTE_URL"
    for i in 1 2 3; do
      git push -q -f origin "$BRANCH" && { echo "Gespeichert"; exit 0; }
      sleep 5
    done
    exit 1
  )
}
refresh_inputs() {
  if git fetch -q --depth=1 origin main 2>/dev/null; then
    if git show "FETCH_HEAD:config.json" > "/tmp/config.json.new" 2>/dev/null; then mv "/tmp/config.json.new" config.json; fi
  fi
}
catalog_age() { # Sekunden seit dem letzten Katalog
  local u
  u=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$DATA_DIR/catalog.json','utf8'));console.log(c.imv===2?Math.floor(Date.parse(c.updated)/1000)||0:0)}catch(e){console.log(0)}")
  echo $(( $(date +%s) - u ))
}

mkdir -p "$DATA_DIR"
while [ "$(date +%s)" -lt "$END" ]; do
  echo "=== Durchlauf $(date -u +%FT%TZ) ==="
  refresh_inputs
  # Katalog aller Karten ab 75: beim ersten Mal und dann alle 6 Stunden (neue Event-Karten kommen so dazu)
  if [ ! -f "$DATA_DIR/catalog.json" ] || [ "$(catalog_age)" -gt 21600 ]; then
    timeout 1500 node catalog.mjs || echo "catalog.mjs fehlgeschlagen"
    save || echo "Speichern fehlgeschlagen"
  fi
  # Chemie-Daten: ein grosser Teil der Spieler pro Durchlauf, bis alle da sind
  if [ -f "$DATA_DIR/catalog.json" ]; then
    META_MAX_SECONDS=840 timeout 1000 node meta.mjs | tee /tmp/meta.log || echo "meta.mjs fehlgeschlagen"
    save || echo "Speichern fehlgeschlagen"
    if grep -q "Nichts zu tun" /tmp/meta.log 2>/dev/null; then echo "Alle Spieler sind aktuell, Pause"; sleep "${PAUSE_SECONDS:-1200}"; fi
  else
    sleep "${PAUSE_SECONDS:-300}"
  fi
done

echo "Dauerlauf beendet, starte den naechsten Lauf"
gh workflow run update-meta.yml || echo "Neustart per Zeitplan"
