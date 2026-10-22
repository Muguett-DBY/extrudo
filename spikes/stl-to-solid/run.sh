#!/usr/bin/env bash
# bash run.sh              the faceted probe (harness.cpp)
# bash run.sh prismatic [case]   the facade's prismatic method on slice 3's matrix (prismatic.cpp)
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
R="$(cd "$S/../.." && pwd)"
if [ "${1:-}" = prismatic ]; then
  IMAGE="${OCCT_IMAGE:-ghcr.io/taucad/opencascade.js:3.1.0-single-threaded}"
  mkdir -p "$S/build"
  # The facade with its private members public, so the harness can look inside.
  sed 's/^ *private:/ public:/' "$R/packages/kernel/occt/facade/extrudo_facade.cpp" > "$S/build/facade_public.cpp"
  # Case g reads one corpus file through FILE, with STL_DIR mounted at /stl (read-only).
  STL_MOUNT=()
  [ -n "${STL_DIR:-}" ] && STL_MOUNT=(-v "$STL_DIR:/stl:ro")
  docker run --rm --user 0 -e FACES="${FACES:-}" -e PIECES="${PIECES:-}" -e FILE="${FILE:-}" -e FACETED_DEBUG="${FACETED_DEBUG:-}" "${STL_MOUNT[@]}" -v "$S:/w" -v "$R/fixtures:/repo/fixtures:ro" -w /w --entrypoint sh "$IMAGE" -c '
    set -e
    LINK=$(ls /opencascade.js/build/occt-libraries/*.a | tr "\n" " ")
    em++ -std=c++17 -O2 -fwasm-exceptions -I/opencascade.js/build/occt-includes prismatic.cpp \
      -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=4GB -sENVIRONMENT=node -sERROR_ON_UNDEFINED_SYMBOLS=0 -sSTACK_SIZE=8MB -sNODERAWFS=1 \
      -Wl,--start-group $LINK -Wl,--end-group -o build/prismatic.cjs
    node build/prismatic.cjs '"${2:-}"
  exit
fi
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
