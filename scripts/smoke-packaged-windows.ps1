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

function Stop-SmokeProcessTree {
  param(
    [System.Diagnostics.Process]$Process
  )

  $Process.Refresh()
  if ($Process.HasExited) {
    return
  }

  $TaskKill = Start-Process `
    -FilePath "taskkill.exe" `
    -ArgumentList @("/PID", $Process.Id.ToString(), "/T", "/F") `
    -NoNewWindow `
    -Wait `
    -PassThru
  if ($TaskKill.ExitCode -ne 0) {
    $Process.Refresh()
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force
    }
  }
  Wait-Process -Id $Process.Id -ErrorAction SilentlyContinue
}

function Remove-SmokeDirectory {
  param(
    [string]$DirectoryPath
  )

  for ($Attempt = 1; $Attempt -le 10; $Attempt += 1) {
    try {
      [IO.Directory]::Delete($DirectoryPath, $true)
      return
    }
    catch [IO.IOException] {
      if ($Attempt -eq 10) {
        throw
      }
      Start-Sleep -Milliseconds 250
    }
  }
}

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
  Stop-SmokeProcessTree -Process $Candidate
  $Candidate = $null

  $Output = (Get-Content $StdoutPath, $StderrPath -Raw -ErrorAction SilentlyContinue) -join "`n"
  if ($Output -match "(?i)ERR_INVALID_ARG_VALUE|uncaught exception|javascript error|resource integrity verification failed|fatal error|UnhandledPromiseRejection|database connection is not open") {
    throw "Packaged Windows main process emitted a startup error.`n$Output"
  }

  Write-Host "Packaged Windows main-process smoke passed."
}
finally {
  if ($null -ne $Candidate -and -not $Candidate.HasExited) {
    Stop-SmokeProcessTree -Process $Candidate
  }
  if (Test-Path $SmokeRoot) {
    Remove-SmokeDirectory -DirectoryPath $SmokeRoot
  }
}
