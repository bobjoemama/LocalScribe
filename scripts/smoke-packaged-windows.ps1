param(
  [string]$AppPath = "out/LocalScribe-win32-x64/LocalScribe.exe"
)

$ErrorActionPreference = "Stop"
$ResolvedApp = (Resolve-Path $AppPath).Path
$ResourcesPath = Join-Path (Split-Path $ResolvedApp -Parent) "resources"
$AsarPath = Join-Path $ResourcesPath "app.asar"

node scripts/verify-packaged-main.mjs $AsarPath
if ($LASTEXITCODE -ne 0) {
  throw "Packaged Windows main-bundle verification failed."
}

$SmokeRoot = Join-Path ([IO.Path]::GetTempPath()) ("localscribe-windows-smoke-" + [guid]::NewGuid())
$ProfilePath = Join-Path $SmokeRoot "profile"
$StdoutPath = Join-Path $SmokeRoot "stdout.log"
$StderrPath = Join-Path $SmokeRoot "stderr.log"
[IO.Directory]::CreateDirectory($ProfilePath) | Out-Null
$Candidate = $null

try {
  $Candidate = Start-Process `
    -FilePath $ResolvedApp `
    -ArgumentList "--user-data-dir=$ProfilePath" `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -PassThru
  Start-Sleep -Seconds 8
  $Candidate.Refresh()
  if ($Candidate.HasExited) {
    $Output = (Get-Content $StdoutPath, $StderrPath -Raw -ErrorAction SilentlyContinue) -join "`n"
    throw "Packaged Windows main process exited during startup.`n$Output"
  }
  Stop-Process -Id $Candidate.Id
  Wait-Process -Id $Candidate.Id -ErrorAction SilentlyContinue
  $Candidate = $null

  $Output = (Get-Content $StdoutPath, $StderrPath -Raw -ErrorAction SilentlyContinue) -join "`n"
  if ($Output -match "(?i)ERR_INVALID_ARG_VALUE|uncaught exception|javascript error|resource integrity verification failed|fatal error|UnhandledPromiseRejection|database connection is not open") {
    throw "Packaged Windows main process emitted a startup error.`n$Output"
  }

  Write-Host "Packaged Windows main-process smoke passed."
}
finally {
  if ($null -ne $Candidate -and -not $Candidate.HasExited) {
    Stop-Process -Id $Candidate.Id -ErrorAction SilentlyContinue
  }
  if (Test-Path $SmokeRoot) {
    [IO.Directory]::Delete($SmokeRoot, $true)
  }
}
