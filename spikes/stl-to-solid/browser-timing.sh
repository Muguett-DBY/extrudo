#!/usr/bin/env bash
# The browser-vs-node Mesh to Solid timings (ADR-0097, slice D4).
#
#   bash spikes/stl-to-solid/browser-timing.sh
#
# Builds the app, copies the three larger own/ STLs a measurement run needs
# into MESH_TIMING_DIR (default /tmp/extrudo-mesh-timing; never into the
# repository), then runs e2e/mesh-to-solid-timing.spec.ts with MESH_TIMING=1
# and prints each file's two timings. Pair them with the kernel sweep's times
# for the same file at Auto. Ubuntu machine settings:
#
#   PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/google-chrome-stable E2E_GPU=1 bash spikes/stl-to-solid/browser-timing.sh
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
R="$(cd "$S/../.." && pwd)"
STL_DIR="${STL_DIR:-$HOME/Development/extrudo-stl-solid-test}"
MESH_TIMING_DIR="${MESH_TIMING_DIR:-/tmp/extrudo-mesh-timing}"
mkdir -p "$MESH_TIMING_DIR"
for f in battery-holder.stl phone-stand-foldable.stl spool-screw-v4.1.stl; do
  cp "$STL_DIR/own/$f" "$MESH_TIMING_DIR/$f"
done
cd "$R"
[ -d apps/web/dist ] || pnpm build
MESH_TIMING=1 MESH_TIMING_DIR="$MESH_TIMING_DIR" \
  pnpm exec playwright test e2e/mesh-to-solid-timing.spec.ts --workers=1 --reporter=list
