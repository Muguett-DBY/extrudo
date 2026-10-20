#!/usr/bin/env bash
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${OCCT_IMAGE:-ghcr.io/taucad/opencascade.js:3.0.2-single-threaded}"
docker run --rm --user 0 -v "$S:/w" -w /w --entrypoint sh "$IMAGE" -c '
  set -e
  ls /opencascade.js/build/occt-libraries | tr "\n" " "; echo
  LINK=""
  for lib in TKDESTL TKDE TKBO TKBool TKFillet TKOffset TKPrim TKShHealing TKTopAlgo TKGeomAlgo TKBRep TKGeomBase TKG3d TKG2d TKMath TKernel TKMesh; do
    [ -f /opencascade.js/build/occt-libraries/lib$lib.a ] && LINK="$LINK /opencascade.js/build/occt-libraries/lib$lib.a"
  done
  mkdir -p build
  em++ -std=c++17 -O2 -fwasm-exceptions -I/opencascade.js/build/occt-includes harness.cpp \
    -sALLOW_MEMORY_GROWTH -sENVIRONMENT=node -sERROR_ON_UNDEFINED_SYMBOLS=0 -sSTACK_SIZE=8MB -sNODERAWFS=1 \
    $LINK -o build/harness.cjs
  node build/harness.cjs'
