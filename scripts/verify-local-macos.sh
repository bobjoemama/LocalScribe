#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Local macOS verification requires an Apple Silicon Mac." >&2
  exit 1
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

npm run verify:local
npm run make:mac
npm run smoke:packaged:macos

PYTHONDONTWRITEBYTECODE=1 \
  resources/python-runtime/venv/bin/python3 -B \
  -m unittest discover -s worker/tests -v

core_sbom="out/localscribe-core-runtime-macos-sbom.cdx.json"
python_sbom="out/localscribe-python-macos-sbom.cdx.json"
npm run --silent sbom:runtime:macos > "$core_sbom"
npm run --silent sbom:python:macos > "$python_sbom"

artifact_count="$(
  find out/make -type f \( -name '*.dmg' -o -name '*.zip' \) | wc -l | tr -d '[:space:]'
)"
if [[ "$artifact_count" -eq 0 ]]; then
  echo "Local macOS verification produced no DMG or ZIP artifacts." >&2
  exit 1
fi

(
  cd out
  {
    find make -type f \( -name '*.dmg' -o -name '*.zip' \) -print0
    printf '%s\0' \
      "$(basename "$core_sbom")" \
      "$(basename "$python_sbom")"
  } |
    xargs -0 shasum -a 256 > SHA256SUMS.txt
  shasum -a 256 -c SHA256SUMS.txt
)

codesign --verify --deep --strict --verbose=4 \
  out/LocalScribe-darwin-arm64/LocalScribe.app
node scripts/verify-macos-entitlements.mjs \
  out/LocalScribe-darwin-arm64/LocalScribe.app

echo "Complete local macOS verification passed."
