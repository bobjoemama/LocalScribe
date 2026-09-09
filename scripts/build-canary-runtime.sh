#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
build_root="$project_root/out/canary-runtime"
output="$project_root/out/runtime-staging/native/macos/liblocalscribe-canary.dylib"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "Canary runtime requires an Apple Silicon build host." >&2
  exit 1
fi
cmake -S "$project_root/tools/canary-runtime" -B "$build_root" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0
cmake --build "$build_root" --target canary-contract-test --parallel "$(sysctl -n hw.ncpu)"
"$build_root/canary-contract-test"
binary="$build_root/liblocalscribe-canary.dylib"
[[ "$(lipo -archs "$binary")" == arm64 ]]
# Only system libraries/frameworks may remain dynamically linked. GGML and
# transcribe.cpp (including Metal shaders) must be embedded in this one dylib.
while IFS= read -r dependency; do
  case "$dependency" in
    @rpath/liblocalscribe-canary.dylib|/usr/lib/*|/System/Library/*) ;;
    *) echo "Non-system Canary dependency: $dependency" >&2; exit 1 ;;
  esac
done < <(otool -L "$binary" | tail -n +2 | awk '{print $1}')
mkdir -p "$(dirname "$output")"
cp "$binary" "$output.tmp.$$"
chmod 755 "$output.tmp.$$"
mv -f "$output.tmp.$$" "$output"
