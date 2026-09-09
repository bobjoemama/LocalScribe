#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
bash "$project_root/scripts/build-canary-runtime.sh"
runtime_root="$project_root/resources/python-runtime"
venv_root="$runtime_root/venv"
worker_root="$project_root/worker"
fluid_audio_helper_root="$project_root/tools/fluidaudio-parakeet-helper"
fluid_audio_helper_output="$project_root/out/runtime-staging/native/macos/localscribe-fluidaudio-parakeet"
python_version="3.12.13"
python_build_tag="20260504"
python_downloads_json="$project_root/scripts/python-build-standalone.json"
uv_version="$(tr -d '[:space:]' < "$project_root/.uv-version")"
if [[ ! "$uv_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo ".uv-version must contain one exact semantic version." >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "The macOS worker runtime must be built on Apple Silicon." >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to build the pinned worker runtime." >&2
  exit 1
fi
if ! command -v swift >/dev/null 2>&1; then
  echo "swift is required to build the pinned FluidAudio helper." >&2
  exit 1
fi
if [[ ! -f "$fluid_audio_helper_root/Package.swift" || ! -f "$fluid_audio_helper_root/Package.resolved" ]]; then
  echo "Pinned FluidAudio helper sources are missing." >&2
  exit 1
fi
if [[ ! -f "$python_downloads_json" ]]; then
  echo "Pinned python-build-standalone metadata is missing." >&2
  exit 1
fi
uv_bin="$(command -v uv)"
uv_version_output="$("$uv_bin" --version)"
if [[ ! "$uv_version_output" =~ ^uv\ ([0-9]+\.[0-9]+\.[0-9]+)(\ \([^()]+\))?$ ]] ||
   [[ "${BASH_REMATCH[1]}" != "$uv_version" ]]; then
  echo "uv version mismatch; expected uv $uv_version." >&2
  exit 1
fi

mkdir -p "$runtime_root"
# This directory is generated output. Preserve only the repository marker so a
# previous build can never leak stale packages into a release.
find "$runtime_root" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf -- {} +

"$uv_bin" lock --check --project "$worker_root"

# The interpreter version and every dependency artifact are pinned. `uv sync
# --locked` refuses to resolve a newer dependency graph during a release build.
"$uv_bin" python install "$python_version" \
  --install-dir "$runtime_root" \
  --no-bin \
  --python-downloads-json-url "file://$python_downloads_json"

python_distribution="$runtime_root/cpython-$python_version-macos-aarch64-none"
if [[ ! -f "$python_distribution/BUILD" ]] ||
   [[ "$(tr -d '[:space:]' < "$python_distribution/BUILD")" != "$python_build_tag" ]]; then
  echo "Bundled CPython does not match pinned python-build-standalone release $python_build_tag." >&2
  exit 1
fi

# uv also creates an absolute version-family alias. Rewrite aliases relative so
# macOS bundle validation does not see links escaping the app bundle.
for runtime_alias in "$runtime_root"/cpython-*; do
  if [[ -L "$runtime_alias" ]]; then
    alias_target="$(readlink "$runtime_alias")"
    ln -sfn "$(basename "$alias_target")" "$runtime_alias"
  fi
done

python_path="$(find "$runtime_root" -path '*/bin/python3' -not -path '*/venv/*' -print -quit)"
if [[ -z "$python_path" ]]; then
  echo "Could not locate the bundled Python interpreter." >&2
  exit 1
fi

"$uv_bin" venv --clear --relocatable --python "$python_path" "$venv_root"
# uv's relocatable activation scripts do not rewrite the interpreter symlink.
# Keep it relative so the entire Resources/python-runtime directory can move.
runtime_name="$(basename "$(dirname "$(dirname "$python_path")")")"
ln -sfn "../../$runtime_name/bin/python3" "$venv_root/bin/python"
UV_PROJECT_ENVIRONMENT="$venv_root" "$uv_bin" sync \
  --project "$worker_root" \
  --locked \
  --no-dev \
  --no-editable \
  --reinstall-package localscribe-worker \
  --link-mode copy \
  --python "$python_path"

# Python distributions and wheels frequently include their own tests, bytecode,
# activation scripts, and developer CLIs. None are required by LocalScribe's
# import-only worker and none belong in a public desktop artifact.
find "$runtime_root" -type d \( \
  -name __pycache__ -o \
  -name .pytest_cache -o \
  -name .mypy_cache -o \
  -name .ruff_cache -o \
  -name test -o \
  -name tests -o \
  -name __tests__ \
\) -prune -exec rm -rf -- {} +
find "$runtime_root" -type f \( \
  -name '*.pyc' -o \
  -name '*.pyo' -o \
  -name '*.map' -o \
  -name '*.sh' -o \
  -name '*.ps1' -o \
  -name '*.bat' -o \
  -name '*.cmd' -o \
  -name CACHEDIR.TAG -o \
  -name .gitignore -o \
  -name .lock \
\) -delete
find "$venv_root/bin" -type f ! -name 'python*' -delete

# Keep the Swift package outside resources: `extraResource` copies native
# resources recursively, so putting source, Package.resolved, or `.build`
# there would ship an auditable but unnecessary source/build tree. Only this
# arm64 executable is promoted into Resources/native/macos and later signed
# alongside the Python runtime by Forge.
swift build --package-path "$fluid_audio_helper_root" -c release
fluid_audio_helper_build_dir="$(swift build --package-path "$fluid_audio_helper_root" -c release --show-bin-path)"
fluid_audio_helper_binary="$fluid_audio_helper_build_dir/localscribe-fluidaudio-parakeet"
if [[ ! -f "$fluid_audio_helper_binary" || ! -x "$fluid_audio_helper_binary" ]]; then
  echo "FluidAudio helper build did not produce an executable." >&2
  exit 1
fi
helper_architecture="$(lipo -archs "$fluid_audio_helper_binary")"
if [[ "$helper_architecture" != "arm64" ]]; then
  echo "FluidAudio helper must be arm64, got: $helper_architecture" >&2
  exit 1
fi
helper_temp="$fluid_audio_helper_output.tmp.$$"
mkdir -p "$(dirname "$fluid_audio_helper_output")"
cp "$fluid_audio_helper_binary" "$helper_temp"
chmod 755 "$helper_temp"
mv -f "$helper_temp" "$fluid_audio_helper_output"

"$venv_root/bin/python3" -B -c \
  'import mlx, mlx_whisper, localscribe_worker; print("Bundled macOS worker runtime is ready")'

resolved_python="$(cd "$(dirname "$venv_root/bin/python3")" && realpath "$venv_root/bin/python3")"
case "$resolved_python" in
  "$runtime_root"/*) ;;
  *)
    echo "Bundled Python resolves outside the runtime: $resolved_python" >&2
    exit 1
    ;;
esac
