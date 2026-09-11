#!/usr/bin/env bash
# Builds the zip you hand to someone who is not going to clone the repo.
#   bash pack.sh
#
# Only the files Chrome actually loads, plus INSTALL.txt. The tests stay out:
# what you ship should look like a product, not like a working directory.
set -euo pipefail
cd "$(dirname "$0")"

RUNTIME=(manifest.json background.js core.js audit.js
         popup.html popup.js panel.html panel.js options.html options.js)

for f in "${RUNTIME[@]}"; do
  [ -f "ext/$f" ] || { echo "missing ext/$f"; exit 1; }
done

# A zip that ships broken logic is worse than no zip.
node ext/test.js >/dev/null && node ext/test-flow.js >/dev/null \
  || { echo "tests fail: not packing"; exit 1; }

VER=$(node -p "require('./ext/manifest.json').version")
OUT="dist/ghl-workflow-auditor-v$VER.zip"

rm -rf dist/stage "$OUT"
mkdir -p dist/stage/ghl-workflow-auditor
cp "${RUNTIME[@]/#/ext/}" dist/stage/ghl-workflow-auditor/
cp INSTALL.txt dist/stage/ghl-workflow-auditor/

powershell -NoProfile -Command \
  "Compress-Archive -Path 'dist/stage/ghl-workflow-auditor' -DestinationPath '$OUT' -Force" \
  2>/dev/null || zip -qr "$OUT" -j dist/stage/ghl-workflow-auditor

rm -rf dist/stage
echo "built  ->  $OUT"
echo "       $(node -p "Math.round(require('fs').statSync('$OUT').size/1024)") KB, $((${#RUNTIME[@]} + 1)) files"
