[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ManifestPath = Join-Path $PSScriptRoot "crispasr-runtime.json"
$Destination = Join-Path $PSScriptRoot "crispasr"
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

if (
  $Manifest.schemaVersion -ne 1 -or
  $Manifest.version -ne "0.8.24" -or
  $Manifest.archive.url -notmatch "^https://github\.com/CrispStrobe/CrispASR/releases/download/"
) {
  throw "The pinned CrispASR runtime manifest is invalid."
}

function Test-PinnedFiles {
  param([Parameter(Mandatory = $true)][string]$Root)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    return $false
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    return $false
  }
  $expectedNames = @($Manifest.files.PSObject.Properties.Name | Sort-Object)
  $children = @(Get-ChildItem -LiteralPath $Root -Force)
  if ($children | Where-Object { $_.PSIsContainer }) {
    return $false
  }
  $actualNames = @($children | Select-Object -ExpandProperty Name | Sort-Object)
  if (Compare-Object -ReferenceObject $expectedNames -DifferenceObject $actualNames) {
    return $false
  }
  foreach ($property in $Manifest.files.PSObject.Properties) {
    $candidate = Join-Path $Root $property.Name
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $false
    }
    $item = Get-Item -LiteralPath $candidate -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      return $false
    }
    $digest = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -ne [string]$property.Value) {
      return $false
    }
  }
  return $true
}

if (Test-PinnedFiles -Root $Destination) {
  Write-Host "Pinned CrispASR $($Manifest.version) runtime is already verified."
  exit 0
}

$TransactionId = [Guid]::NewGuid().ToString("N")
$TransactionRoot = Join-Path $PSScriptRoot ".crispasr-runtime-$TransactionId"
$ArchivePath = Join-Path $TransactionRoot "runtime.zip"
$ExtractedPath = Join-Path $TransactionRoot "extracted"
$StagedPath = Join-Path $TransactionRoot "staged"
$BackupPath = Join-Path $TransactionRoot "previous"

[void](New-Item -ItemType Directory -Path $ExtractedPath)
[void](New-Item -ItemType Directory -Path $StagedPath)

try {
  Invoke-WebRequest -Uri $Manifest.archive.url -OutFile $ArchivePath -UseBasicParsing
  $archiveDigest = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($archiveDigest -ne [string]$Manifest.archive.sha256) {
    throw "The downloaded CrispASR archive failed SHA-256 verification."
  }

  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractedPath
  $ArchiveRoot = Join-Path $ExtractedPath $Manifest.archive.rootDirectory
  foreach ($property in $Manifest.files.PSObject.Properties) {
    $source = Join-Path $ArchiveRoot $property.Name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "The pinned CrispASR archive is missing $($property.Name)."
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $StagedPath $property.Name)
  }
  if (-not (Test-PinnedFiles -Root $StagedPath)) {
    throw "The staged CrispASR runtime failed its exact-file verification."
  }

  if (Test-Path -LiteralPath $Destination) {
    Move-Item -LiteralPath $Destination -Destination $BackupPath
  }
  try {
    Move-Item -LiteralPath $StagedPath -Destination $Destination
  }
  catch {
    if (
      -not (Test-Path -LiteralPath $Destination) -and
      (Test-Path -LiteralPath $BackupPath)
    ) {
      Move-Item -LiteralPath $BackupPath -Destination $Destination
    }
    throw
  }
  if (-not (Test-PinnedFiles -Root $Destination)) {
    throw "The activated CrispASR runtime failed verification."
  }
  Write-Host "Prepared pinned CrispASR $($Manifest.version) CUDA runtime."
}
finally {
  if (Test-Path -LiteralPath $TransactionRoot) {
    Remove-Item -LiteralPath $TransactionRoot -Recurse -Force
  }
}
