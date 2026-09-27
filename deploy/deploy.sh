#!/usr/bin/env bash
set -euo pipefail

SRC="$HOME/Model/linkml-viewer"
LABEL="com.semiac.linkml-viewer"

cd "$SRC"
npm install
BASE_PATH=/linkml-viewer npm run build

launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "deployed -> https://plugin.dhd.nl/linkml-viewer/"
