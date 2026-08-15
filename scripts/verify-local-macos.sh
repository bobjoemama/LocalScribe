#!/usr/bin/env bash

set -euo pipefail

smoke_model_root=""
smoke_audio=""
smoke_family="whisper-large-v3"
smoke_tier="medium"
smoke_mode="after-stop"
smoke_repeat="1"
smoke_requested="0"
while (($#)); do
  case "$1" in
    --smoke-model-root) smoke_requested="1"; smoke_model_root="${2:?missing value for --smoke-model-root}"; shift 2 ;;
    --smoke-audio) smoke_requested="1"; smoke_audio="${2:?missing value for --smoke-audio}"; shift 2 ;;
    --smoke-family) smoke_requested="1"; smoke_family="${2:?missing value for --smoke-family}"; shift 2 ;;
    --smoke-tier) smoke_requested="1"; smoke_tier="${2:?missing value for --smoke-tier}"; shift 2 ;;
    --smoke-mode) smoke_requested="1"; smoke_mode="${2:?missing value for --smoke-mode}"; shift 2 ;;
    --smoke-repeat) smoke_requested="1"; smoke_repeat="${2:?missing value for --smoke-repeat}"; shift 2 ;;
    *) echo "Unknown macOS verification argument: $1" >&2; exit 2 ;;
  esac
done
if [[ "$smoke_requested" == "1" ]]; then
  if [[ -z "$smoke_model_root" || -z "$smoke_audio" ]]; then
    echo "Real model smoke requires both --smoke-model-root and --smoke-audio." >&2
    exit 2
  fi
fi

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

if [[ -n "$smoke_model_root" ]]; then
  PYTHONDONTWRITEBYTECODE=1 resources/python-runtime/venv/bin/python3 -B \
    scripts/smoke-worker.py \
    --python resources/python-runtime/venv/bin/python3 \
    --worker worker \
    --model-root "$smoke_model_root" \
    --audio "$smoke_audio" \
    --family "$smoke_family" \
    --tier "$smoke_tier" \
    --mode "$smoke_mode" \
    --repeat "$smoke_repeat"
fi

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
node scripts/verify-release-assets.mjs --platform darwin --candidate >/dev/null

codesign --verify --deep --strict --verbose=4 "$app_path"
node scripts/verify-macos-entitlements.mjs "$app_path"

echo "Complete local macOS verification passed for $product_name $app_version."
