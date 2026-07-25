$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ResourcesRoot = Join-Path $ProjectRoot "resources"
$RuntimeRoot = Join-Path $ResourcesRoot "python-runtime-windows"
$WorkerRoot = Join-Path $ProjectRoot "worker\windows_transformers"
$PythonVersion = "3.12.13"
$UvVersion = (Get-Content -LiteralPath (Join-Path $ProjectRoot ".uv-version") -Raw).Trim()
if ($UvVersion -notmatch "^\d+\.\d+\.\d+$") {
  throw ".uv-version must contain one exact semantic version."
}
$TransactionId = [Guid]::NewGuid().ToString("N")
$StagingRoot = Join-Path $ResourcesRoot ".python-runtime-windows-build-$TransactionId"
$BackupRoot = Join-Path $ResourcesRoot ".python-runtime-windows-backup-$TransactionId"
$OwnershipMarkerName = ".localscribe-runtime-build"
$StagingMarker = Join-Path $StagingRoot $OwnershipMarkerName

function Assert-OrdinaryDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    throw "$Label is missing: $LiteralPath"
  }
  $Item = Get-Item -LiteralPath $LiteralPath -Force
  if (
    -not $Item.PSIsContainer -or
    ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "$Label must be an ordinary directory, not a file, link, or reparse point: $LiteralPath"
  }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Remove-OwnedTransaction {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    return
  }
  Assert-OrdinaryDirectory -LiteralPath $LiteralPath -Label "Runtime transaction"
  $Marker = Join-Path $LiteralPath $OwnershipMarkerName
  if (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) {
    throw "Refusing to remove an unowned runtime transaction: $LiteralPath"
  }
  $ExpectedParent = [IO.Path]::GetFullPath($ResourcesRoot).TrimEnd("\")
  $Resolved = [IO.Path]::GetFullPath($LiteralPath)
  if (-not $Resolved.StartsWith(
      "$ExpectedParent\",
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to remove a runtime transaction outside resources: $Resolved"
  }
  Get-ChildItem -LiteralPath $LiteralPath -Recurse -Force |
    Where-Object {
      ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    } |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object { $_.Delete() }
  $RemainingReparsePoints = @(
    Get-ChildItem -LiteralPath $LiteralPath -Recurse -Force |
      Where-Object {
        ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
      }
  )
  if ($RemainingReparsePoints.Count -ne 0) {
    throw "Refusing to remove a runtime transaction containing reparse points: $LiteralPath"
  }
  Remove-Item -LiteralPath $LiteralPath -Recurse -Force
}

function Assert-OwnedTransaction {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  Assert-OrdinaryDirectory -LiteralPath $LiteralPath -Label "Runtime transaction"
  $Name = Split-Path -Leaf $LiteralPath
  if ($Name -notmatch "^\.python-runtime-windows-(?:build|backup)-([a-f0-9]{32})$") {
    throw "Runtime transaction has an invalid name: $LiteralPath"
  }
  $Marker = Join-Path $LiteralPath $OwnershipMarkerName
  if (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) {
    throw "Runtime transaction is missing its ownership marker: $LiteralPath"
  }
  $MarkerItem = Get-Item -LiteralPath $Marker -Force
  if (
    $MarkerItem.PSIsContainer -or
    ($MarkerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    (Get-Content -LiteralPath $Marker -Raw).Trim() -ne $Matches[1]
  ) {
    throw "Runtime transaction ownership marker is invalid: $LiteralPath"
  }
}

function Recover-StaleTransactions {
  $Backups = @(
    Get-ChildItem -LiteralPath $ResourcesRoot -Directory -Force |
      Where-Object { $_.Name -like ".python-runtime-windows-backup-*" }
  )
  $Builds = @(
    Get-ChildItem -LiteralPath $ResourcesRoot -Directory -Force |
      Where-Object { $_.Name -like ".python-runtime-windows-build-*" }
  )
  foreach ($Transaction in @($Backups + $Builds)) {
    Assert-OwnedTransaction -LiteralPath $Transaction.FullName
  }

  if (-not (Test-Path -LiteralPath $RuntimeRoot) -and $Backups.Count -gt 0) {
    if ($Backups.Count -ne 1) {
      throw "Cannot recover Windows runtime because multiple owned backups exist."
    }
    $BackupMarker = Join-Path $Backups[0].FullName $OwnershipMarkerName
    Remove-Item -LiteralPath $BackupMarker -Force
    Move-Item -LiteralPath $Backups[0].FullName -Destination $RuntimeRoot
    $Backups = @()
  }

  foreach ($Transaction in @($Backups + $Builds)) {
    Remove-OwnedTransaction -LiteralPath $Transaction.FullName
  }

  if (Test-Path -LiteralPath $RuntimeRoot) {
    $RuntimeMarker = Join-Path $RuntimeRoot $OwnershipMarkerName
    if (Test-Path -LiteralPath $RuntimeMarker) {
      $MarkerItem = Get-Item -LiteralPath $RuntimeMarker -Force
      $MarkerValue = if ($MarkerItem.PSIsContainer) {
        ""
      } else {
        (Get-Content -LiteralPath $RuntimeMarker -Raw).Trim()
      }
      if (
        $MarkerItem.PSIsContainer -or
        ($MarkerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $MarkerValue -notmatch "^[a-f0-9]{32}$"
      ) {
        throw "Existing Windows runtime contains an invalid transaction marker."
      }
      Remove-Item -LiteralPath $RuntimeMarker -Force
    }
  }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "The Windows worker runtime must be built on Windows x64."
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
  throw "The Windows worker runtime must be built on an x64 host."
}

Assert-OrdinaryDirectory -LiteralPath $ResourcesRoot -Label "Resources root"
Recover-StaleTransactions
if (Test-Path -LiteralPath $RuntimeRoot) {
  Assert-OrdinaryDirectory -LiteralPath $RuntimeRoot -Label "Existing Windows runtime root"
  $ExistingRuntimeReparsePoints = @(
    Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -Force |
      Where-Object {
        ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
      }
  )
  if ($ExistingRuntimeReparsePoints.Count -ne 0) {
    throw "Existing Windows runtime root contains a link or reparse point."
  }
}
foreach ($Candidate in @($StagingRoot, $BackupRoot)) {
  if (Test-Path -LiteralPath $Candidate) {
    throw "Fresh runtime transaction path already exists: $Candidate"
  }
}

$UvCommand = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $UvCommand) {
  throw "uv $UvVersion is required to build the pinned worker runtime."
}
$UvExecutable = $UvCommand.Source
if (
  [string]::IsNullOrWhiteSpace($UvExecutable) -or
  -not [IO.Path]::IsPathFullyQualified($UvExecutable) -or
  -not (Test-Path -LiteralPath $UvExecutable -PathType Leaf)
) {
  throw "uv did not resolve to an ordinary absolute executable."
}
$UvVersionOutput = (& $UvExecutable --version)
$UvVersionText = ($UvVersionOutput -join "`n").Trim()
if (
  $LASTEXITCODE -ne 0 -or
  $UvVersionText -notmatch "^uv (\d+\.\d+\.\d+)(?: \([^\r\n]+\))?$" -or
  $Matches[1] -ne $UvVersion
) {
  throw "uv version mismatch: expected uv $UvVersion, received $(($UvVersionOutput -join ' ').Trim())."
}

New-Item -ItemType Directory -Path $StagingRoot | Out-Null
[IO.File]::WriteAllText(
  $StagingMarker,
  "$TransactionId`n",
  [Text.UTF8Encoding]::new($false)
)

$PreviousUvEnvironment = $env:UV_PROJECT_ENVIRONMENT
$Promoted = $false
try {
  Invoke-Checked `
    -Executable $UvExecutable `
    -Arguments @("lock", "--check", "--project", $WorkerRoot) `
    -Label "Locked Windows worker dependency check"

  # Keep interpreter and package resolution deterministic. The committed
  # lockfile includes every artifact hash consumed by the locked sync.
  Invoke-Checked `
    -Executable $UvExecutable `
    -Arguments @(
      "python", "install", $PythonVersion,
      "--install-dir", $StagingRoot,
      "--no-bin"
    ) `
    -Label "Pinned Python installation"

  $ManagedPythonRoot = Join-Path $StagingRoot "cpython-$PythonVersion-windows-x86_64-none"
  $Python = Join-Path $ManagedPythonRoot "python.exe"
  if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Bundled Python interpreter was not found at the pinned install path."
  }

  $VenvRoot = Join-Path $StagingRoot "venv"
  Invoke-Checked `
    -Executable $UvExecutable `
    -Arguments @(
      "venv", "--clear", "--relocatable",
      "--python", $Python,
      $VenvRoot
    ) `
    -Label "Relocatable virtual environment creation"
  $env:UV_PROJECT_ENVIRONMENT = $VenvRoot
  Invoke-Checked `
    -Executable $UvExecutable `
    -Arguments @(
      "sync",
      "--project", $WorkerRoot,
      "--locked",
      "--no-dev",
      "--no-editable",
      "--reinstall-package", "localscribe-windows-faster-whisper-worker",
      "--link-mode", "copy",
      "--python", $Python
    ) `
    -Label "Locked Windows worker runtime sync"

  # uv creates absolute convenience aliases on Windows. No reparse point may
  # enter a portable artifact or survive the external-runtime build.
  Get-ChildItem -LiteralPath $StagingRoot -Force |
    Where-Object {
      ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    } |
    ForEach-Object { $_.Delete() }

  $ForbiddenDirectories = @(
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "test",
    "tests",
    "__tests__"
  )
  Get-ChildItem -LiteralPath $StagingRoot -Recurse -Directory -Force |
    Where-Object { $ForbiddenDirectories -contains $_.Name } |
    Sort-Object { $_.FullName.Length } -Descending |
    Remove-Item -Recurse -Force

  $ForbiddenFileNames = @("CACHEDIR.TAG", ".gitignore", ".lock")
  $ForbiddenExtensions = @(".pyc", ".pyo", ".map", ".sh", ".ps1", ".bat", ".cmd")
  Get-ChildItem -LiteralPath $StagingRoot -Recurse -File -Force |
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
  $RemainingReparsePoints = @(Get-ChildItem -LiteralPath $StagingRoot -Recurse -Force |
    Where-Object {
      ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    })
  if ($RemainingReparsePoints.Count -ne 0) {
    $Paths = ($RemainingReparsePoints | ForEach-Object { $_.FullName }) -join ", "
    throw "Relocatable runtime still contains non-portable reparse points: $Paths"
  }
  Invoke-Checked `
    -Executable $BundledPython `
    -Arguments @(
      "-B", "-c",
      "import ctranslate2, faster_whisper, localscribe_windows_worker; print('Bundled Windows worker runtime is ready')"
    ) `
    -Label "Bundled Windows worker import smoke"

  $BackupCreated = $false
  try {
    if (Test-Path -LiteralPath $RuntimeRoot) {
      [IO.File]::WriteAllText(
        (Join-Path $RuntimeRoot $OwnershipMarkerName),
        "$TransactionId`n",
        [Text.UTF8Encoding]::new($false)
      )
      Move-Item -LiteralPath $RuntimeRoot -Destination $BackupRoot
      $BackupCreated = $true
    }
    Move-Item -LiteralPath $StagingRoot -Destination $RuntimeRoot
    Remove-Item -LiteralPath (Join-Path $RuntimeRoot $OwnershipMarkerName) -Force
    $Promoted = $true
  }
  catch {
    if (
      (Test-Path -LiteralPath $StagingRoot) -and
      -not (Test-Path -LiteralPath $StagingMarker)
    ) {
      [IO.File]::WriteAllText(
        $StagingMarker,
        "$TransactionId`n",
        [Text.UTF8Encoding]::new($false)
      )
    }
    if (
      $BackupCreated -and
      -not (Test-Path -LiteralPath $RuntimeRoot) -and
      (Test-Path -LiteralPath $BackupRoot)
    ) {
      $BackupMarker = Join-Path $BackupRoot $OwnershipMarkerName
      if (Test-Path -LiteralPath $BackupMarker -PathType Leaf) {
        Remove-Item -LiteralPath $BackupMarker -Force
      }
      Move-Item -LiteralPath $BackupRoot -Destination $RuntimeRoot
    }
    elseif (
      -not $BackupCreated -and
      (Test-Path -LiteralPath $RuntimeRoot) -and
      (Test-Path -LiteralPath (Join-Path $RuntimeRoot $OwnershipMarkerName))
    ) {
      Remove-Item -LiteralPath (Join-Path $RuntimeRoot $OwnershipMarkerName) -Force
    }
    throw
  }
  if (Test-Path -LiteralPath $BackupRoot) {
    Remove-OwnedTransaction -LiteralPath $BackupRoot
  }
}
finally {
  $env:UV_PROJECT_ENVIRONMENT = $PreviousUvEnvironment
  if (-not $Promoted -and (Test-Path -LiteralPath $StagingRoot)) {
    Remove-OwnedTransaction -LiteralPath $StagingRoot
  }
}
