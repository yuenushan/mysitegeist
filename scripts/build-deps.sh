#!/bin/bash

# Generate dist/ for the vendored frozen packages from their committed src/.
# Nothing under vendor/**/dist is committed to git - this script (re)creates
# the build outputs. Idempotent: a package is rebuilt only when one of its src
# files is newer than its dist/index.js.
#
# Toolchain notes (why this does not just run each package's `npm run build`):
# - ai/agent upstream compile with `tsgo`, which only exists in the pi-mono
#   workspace root and is not vendored; plain typescript@5 emits equivalent
#   output for these non-Lit packages.
# - web-ui and mini-lit contain Lit components and MUST be compiled with
#   typescript@5: the TS-native compiler mis-emits Lit decorator reactivity
#   (see CHANGELOG). They get their own typescript@5 via --no-save installs.
# - ai's `generate-models` step is a network-bound generator and is skipped:
#   src/models.generated.ts is committed and frozen.
# - web-ui's tailwindcss step uses the root installation's binary.

set -e
cd "$(dirname "$0")/.."

TAILWIND="$(pwd)/node_modules/.bin/tailwindcss"
if [ ! -x "$TAILWIND" ]; then
	echo "error: root dependencies missing - run 'npm install' at the repo root first" >&2
	exit 1
fi

needs_build() { # pkg: returns 0 when dist is missing or a src file is newer
	local pkg="$1"
	if [ ! -f "$pkg/dist/index.js" ]; then
		return 0
	fi
	[ -n "$(find "$pkg/src" -type f -newer "$pkg/dist/index.js" -print -quit 2>/dev/null)" ]
}

ensure_toolchain() { # pkg
	local pkg="$1"
	if [ ! -x "$pkg/node_modules/.bin/tsc" ]; then
		echo "  installing local toolchain (typescript@5, @types/node) ..."
		(cd "$pkg" && npm install --no-save --no-audit --no-fund "typescript@5" "@types/node" --silent)
	fi
}

build_pkg() { # pkg [tsc args...]
	local pkg="$1"
	shift
	ensure_toolchain "$pkg"
	(cd "$pkg" && ./node_modules/.bin/tsc "$@")
}

echo "==> vendor/mini-lit"
if needs_build vendor/mini-lit; then
	build_pkg vendor/mini-lit
else
	echo "  up to date"
fi

for pkg in vendor/pi-mono/packages/ai vendor/pi-mono/packages/agent vendor/pi-mono/packages/web-ui; do
	echo "==> $pkg"
	if needs_build "$pkg"; then
		build_pkg "$pkg" -p tsconfig.build.json
		if [ "$pkg" = "vendor/pi-mono/packages/web-ui" ] && [ -f "$pkg/src/app.css" ]; then
			echo "  tailwindcss -> dist/app.css"
			"$TAILWIND" -i "$pkg/src/app.css" -o "$pkg/dist/app.css" --minify
		fi
	else
		echo "  up to date"
	fi
done

echo "vendor dist ready."
