#!/usr/bin/env bash
# Dauerlauf: holt alle 15 Minuten (zu :00, :15, :30, :45 UTC) die Preise und das aktuelle TOTW- und Event-Team, einmal pro Stunde die Leaks,
# und speichert nach jedem Durchlauf in den Branch "data". Nach rund 5,5 Stunden startet sich der Lauf neu.
# So haengt die Aktualisierung nicht am Zeitplan von GitHub, der oft verspaetet oder Laeufe auslaesst.
set -u
DATA_DIR="${DATA_DIR:-data}"
LOOP_SECONDS="${LOOP_SECONDS:-20100}"   # ca. 5,6 Stunden
INTERVAL="${INTERVAL:-900}"             # 15 Minuten
REMOTE_URL="${REMOTE_URL:-https://x-access-token:${GH_TOKEN:-}@github.com/${GITHUB_REPOSITORY:-}.git}"
END=$(( $(date +%s) + LOOP_SECONDS ))
LAST_LEAK_HOUR=""

save() {
  (
    cd "$DATA_DIR" || exit 1
    [ -f prices.json ] || { echo "Keine Daten zum Speichern"; exit 0; }
    rm -rf .git
    git init -q -b data
    git config user.name "scout-bot"
    git config user.email "scout-bot@users.noreply.github.com"
    git add -A
    git commit -q -m "Daten $(date -u +%FT%TZ)"
    git remote add origin "$REMOTE_URL"
    for i in 1 2 3; do
      git push -q -f origin data && { echo "Gespeichert"; exit 0; }
      sleep 5
    done
    exit 1
  )
}

refresh_inputs() {
  # manual.json und config.json bei jedem Durchlauf frisch aus main holen, damit Aenderungen ohne Neustart gelten
  if git fetch -q --depth=1 origin main 2>/dev/null; then
    for f in manual.json config.json; do
      if git show "FETCH_HEAD:$f" > "/tmp/$f.new" 2>/dev/null; then mv "/tmp/$f.new" "$f"; fi
    done
  fi
}

while [ "$(date +%s)" -lt "$END" ]; do
  echo "=== Durchlauf $(date -u +%FT%TZ) ==="
  refresh_inputs
  node update.mjs || echo "update.mjs fehlgeschlagen, naechster Versuch im naechsten Durchlauf"
  node teams.mjs || echo "teams.mjs fehlgeschlagen (TOTW/Event-Team bleiben auf dem letzten Stand)"
  H=$(date -u +%H)
  if [ "$H" != "$LAST_LEAK_HOUR" ]; then
    node leaks.mjs || echo "leaks.mjs fehlgeschlagen"
    LAST_LEAK_HOUR="$H"
  fi
  save || echo "Speichern fehlgeschlagen"
  NOW=$(date +%s)
  NEXT=$(( (NOW / INTERVAL + 1) * INTERVAL ))
  if [ "$NEXT" -ge "$END" ]; then break; fi
  echo "Warte $((NEXT - NOW)) Sekunden bis zum naechsten Durchlauf"
  sleep $((NEXT - NOW))
done

echo "Dauerlauf beendet, starte den naechsten Lauf"
gh workflow run update.yml || echo "Neustart per Zeitplan"
