#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NPM_BIN="${NPM_BIN:-$(command -v npm)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
APP_NAME="Costco Receipt Organizer"

"$NPM_BIN" run dist
VERSION="$("$NODE_BIN" -p "require('./package.json').version")"
APPS=("$ROOT"/dist/mac*/"$APP_NAME.app"(N))
DMGS=("$ROOT"/dist/Costco-Receipt-Organizer-"$VERSION"-*.dmg(N))

if (( ${#APPS[@]} == 0 || ${#DMGS[@]} == 0 )); then
  echo "The app or DMG build output could not be found." >&2
  exit 1
fi

rm -rf "$ROOT/$APP_NAME.app" "$ROOT/$APP_NAME.dmg"
cp -R "$APPS[1]" "$ROOT/$APP_NAME.app"
cp "$DMGS[1]" "$ROOT/$APP_NAME.dmg"
echo "Built $ROOT/$APP_NAME.dmg"
