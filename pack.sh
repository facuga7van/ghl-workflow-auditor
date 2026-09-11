#!/usr/bin/env bash
# Builds the zip you hand to someone who is not going to clone the repo.
#   bash pack.sh
#
# Only the files Chrome actually loads, plus INSTALL.txt. The tests stay out:
# what you ship should look like a product, not like a working directory.
set -euo pipefail
cd "$(dirname "$0")"

RUNTIME=(manifest.json background.js core.js audit.js
         popup.html popup.js panel.html panel.js options.html options.js demo.js)
ICONS=(icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png)

for f in "${RUNTIME[@]}" "${ICONS[@]}"; do
  [ -f "ext/$f" ] || { echo "missing ext/$f"; exit 1; }
done

# A zip that ships broken logic is worse than no zip.
for t in test.js test-graph.js test-flow.js; do
  node "ext/$t" >/dev/null || { echo "ext/$t fails: not packing"; exit 1; }
done

VER=$(node -p "require('./ext/manifest.json').version")
OUT="dist/ghl-workflow-auditor-v$VER.zip"
STORE="dist/ghl-workflow-auditor-v$VER-webstore.zip"

zipit(){   # $1 = folder to archive, $2 = destination
  powershell -NoProfile -Command "Compress-Archive -Path '$1' -DestinationPath '$2' -Force" \
    2>/dev/null || (cd "$(dirname "$1")" && zip -qr "../../$2" "$(basename "$1")")
}

rm -rf dist/stage "$OUT" "$STORE"
mkdir -p dist/stage/ghl-workflow-auditor/icons
cp "${RUNTIME[@]/#/ext/}" dist/stage/ghl-workflow-auditor/
cp "${ICONS[@]/#/ext/}" dist/stage/ghl-workflow-auditor/icons/
cp INSTALL.txt dist/stage/ghl-workflow-auditor/
zipit 'dist/stage/ghl-workflow-auditor' "$OUT"

# The Chrome Web Store needs manifest.json at the ROOT of the zip. A wrapping
# folder gets you "manifest file is missing or unreadable" on upload, which
# looks like a broken build and is not. INSTALL.txt stays out: the Store
# installs it for you, so instructions for unpacking make no sense there.
rm -rf dist/store && mkdir -p dist/store/icons
cp "${RUNTIME[@]/#/ext/}" dist/store/
cp "${ICONS[@]/#/ext/}" dist/store/icons/
zipit 'dist/store/*' "$STORE"

rm -rf dist/stage dist/store
kb(){ node -p "Math.round(require('fs').statSync('$1').size/1024)"; }
echo "built  ->  $OUT            $(kb "$OUT") KB   (unpacked install, has INSTALL.txt)"
echo "           $STORE   $(kb "$STORE") KB   (upload THIS one to the Web Store)"
