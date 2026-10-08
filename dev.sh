#!/bin/bash

# Start all development servers for sitegeist and its vendored dependencies
# Usage: ./dev.sh

set -e

echo "Starting development servers..."
echo ""

# Generate the vendored packages' dist/ (installs their minimal toolchains once);
# must run before the watchers start so they never build concurrently
bash scripts/build-deps.sh

# Kill all child processes on exit
trap 'echo ""; echo "Stopping all dev servers..."; kill 0' EXIT INT TERM

# Start dev servers for the vendored packages
echo "Starting mini-lit watcher..."
(cd vendor/mini-lit && npm run dev:tsc) &

echo "Starting web-ui watcher..."
(cd vendor/pi-mono/packages/web-ui && npm run dev:tsc) &

# ai and agent ship prebuilt dist/; after editing their sources rebuild manually:
#   (cd vendor/pi-mono/packages/ai && npm run build)
#   (cd vendor/pi-mono/packages/agent && npm run build)

# Wait a moment for dependencies to start building
sleep 2

echo "Starting sitegeist dev server..."
npm run dev &

echo "Starting sitegeist site dev server..."
(cd site && ./run.sh dev) &

echo ""
echo "All dev services started"
echo "  mini-lit: watching"
echo "  web-ui: watching"
echo "  sitegeist: watching"
echo "  site backend: http://localhost:3000"
echo "  site frontend: http://localhost:8080"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Wait for all background jobs
wait
