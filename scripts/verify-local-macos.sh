#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Local macOS verification requires an Apple Silicon Mac." >&2
  exit 1
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
IFS=$'\t' read -r \
  product_name app_version target_arch package_directory app_path \
  core_sbom python_sbom checksum_path dmg_path zip_path < <(
    node scripts/release-metadata.mjs --platform darwin --format tsv
  )

if [[ "$target_arch" != "$(uname -m)" ]]; then
  echo "Release metadata target $target_arch does not match this Mac." >&2
  exit 1
fi

npm run verify:local
npm run make:mac
npm run smoke:packaged:macos

PYTHONDONTWRITEBYTECODE=1 \
  resources/python-runtime/venv/bin/python3 -B \
  -m unittest discover -s worker/tests -v

npm run --silent sbom:runtime:macos > "$core_sbom"
npm run --silent sbom:python:macos > "$python_sbom"

for artifact in "$dmg_path" "$zip_path" "$core_sbom" "$python_sbom"; do
  if [[ ! -f "$artifact" || -L "$artifact" ]]; then
    echo "Local macOS verification is missing an ordinary release asset: $artifact" >&2
    exit 1
  fi
done

(
  cd out
  shasum -a 256 -- \
    "${dmg_path#"$project_root/out/"}" \
    "${zip_path#"$project_root/out/"}" \
    "${core_sbom#"$project_root/out/"}" \
    "${python_sbom#"$project_root/out/"}" \
    > "$(basename "$checksum_path")"
  shasum -a 256 -c "$(basename "$checksum_path")"
)
node scripts/verify-release-assets.mjs --platform darwin >/dev/null

codesign --verify --deep --strict --verbose=4 "$app_path"
node scripts/verify-macos-entitlements.mjs "$app_path"

echo "Complete local macOS verification passed for $product_name $app_version."
