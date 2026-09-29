#!/bin/bash
# Install the built extension into a Chrome-loadable directory.
#
# Usage:
#   ./install.sh [target-dir]
#
# Target directory resolution (first match wins):
#   1. First CLI argument
#   2. $SITEGEIST_INSTALL_DIR environment variable
#   3. ~/Downloads/sitegeist (default)
#
# After installing, reload the extension in chrome://extensions/ to pick up
# the changes. If manifest.json changed (e.g. new permissions), Chrome may
# require removing the extension and running "Load unpacked" again.

set -e

TARGET_DIR="${1:-${SITEGEIST_INSTALL_DIR:-$HOME/Downloads/sitegeist}}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$REPO_DIR"

echo "🔨 Building sitegeist..."
npm run build

echo ""
echo "📦 Installing to $TARGET_DIR ..."
mkdir -p "$TARGET_DIR"
rsync -a --delete dist-chrome/ "$TARGET_DIR/"

echo ""
echo "✅ Installed. Reload the extension to pick up the changes:"
echo "   1. Open chrome://extensions/"
echo "   2. Click ↻ on the Sitegeist card"
echo "      (only when manifest.json changed: remove + 'Load unpacked' again)"
