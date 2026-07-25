#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_root="$project_root/resources/python-runtime"
venv_root="$runtime_root/venv"
worker_root="$project_root/worker"
python_version="3.12.13"
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
"$uv_bin" python install "$python_version" --install-dir "$runtime_root" --no-bin

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
