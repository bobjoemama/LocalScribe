$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $ProjectRoot "resources\python-runtime-windows"
$VenvRoot = Join-Path $RuntimeRoot "venv"
$WorkerRoot = Join-Path $ProjectRoot "worker\windows_transformers"
$PythonVersion = "3.12.13"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "The Windows worker runtime must be built on Windows x64."
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
  throw "The Windows worker runtime must be built on an x64 host."
}
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw "uv is required to build the pinned worker runtime."
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
Get-ChildItem -LiteralPath $RuntimeRoot -Force |
  Where-Object { $_.Name -ne ".gitkeep" } |
  Remove-Item -Recurse -Force

uv lock --check --project $WorkerRoot

# Keep interpreter and package resolution deterministic. The committed lockfile
# includes the artifact hashes consumed by `uv sync --locked` below.
uv python install $PythonVersion --install-dir $RuntimeRoot --no-bin
$Python = Get-ChildItem $RuntimeRoot -Recurse -Filter python.exe |
  Where-Object { $_.FullName -notlike "*\venv\*" } |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $Python) { throw "Bundled Python interpreter was not found." }

uv venv --clear --relocatable --python $Python $VenvRoot
$env:UV_PROJECT_ENVIRONMENT = $VenvRoot
uv sync `
  --project $WorkerRoot `
  --locked `
  --no-dev `
  --no-editable `
  --link-mode copy `
  --python $Python

# Remove wheel tests, bytecode/caches, activation scripts, and developer-only
# console entrypoints before Forge copies this runtime into the installer.
$ForbiddenDirectories = @(
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "test",
  "tests",
  "__tests__"
)
Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -Directory -Force |
  Where-Object { $ForbiddenDirectories -contains $_.Name } |
  Sort-Object { $_.FullName.Length } -Descending |
  Remove-Item -Recurse -Force

$ForbiddenFileNames = @("CACHEDIR.TAG", ".gitignore", ".lock")
$ForbiddenExtensions = @(".pyc", ".pyo", ".map", ".sh", ".ps1", ".bat", ".cmd")
Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -File -Force |
  Where-Object {
    $ForbiddenFileNames -contains $_.Name -or
    $ForbiddenExtensions -contains $_.Extension.ToLowerInvariant()
  } |
  Remove-Item -Force

$VenvScripts = Join-Path $VenvRoot "Scripts"
Get-ChildItem -LiteralPath $VenvScripts -File -Force |
  Where-Object {
    $_.Name -notin @("python.exe", "pythonw.exe", "python3.exe", "python3.12.exe") -and
    $_.Extension.ToLowerInvariant() -notin @(".dll", ".pyd")
  } |
  Remove-Item -Force

$BundledPython = Join-Path $VenvScripts "python.exe"
if (-not (Test-Path -LiteralPath $BundledPython -PathType Leaf)) {
  throw "Relocatable runtime is missing venv\Scripts\python.exe."
}
& $BundledPython -B -c "import ctranslate2, faster_whisper, localscribe_windows_worker; print('Bundled Windows worker runtime is ready')"
