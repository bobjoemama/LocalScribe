[CmdletBinding()]
param(
  [switch]$RequireCuda,
  [string]$CudaModelRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "Complete local Windows verification requires Windows."
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
  throw "Complete local Windows verification requires an x64 host."
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$ExpectedNodeVersion = (Get-Content -LiteralPath (Join-Path $ProjectRoot ".nvmrc") -Raw).Trim()
$ExpectedNodeVersion = $ExpectedNodeVersion.TrimStart([char]"v")
$ActualNodeVersion = (& node --version).Trim().TrimStart([char]"v")
if ($LASTEXITCODE -ne 0 -or $ActualNodeVersion -ne $ExpectedNodeVersion) {
  throw "Node version mismatch: expected $ExpectedNodeVersion, received $ActualNodeVersion."
}

npm run verify:local
if ($LASTEXITCODE -ne 0) {
  throw "Local source verification failed."
}

npm run make:windows
if ($LASTEXITCODE -ne 0) {
  throw "Windows packaging failed."
}

npm run smoke:packaged:windows
if ($LASTEXITCODE -ne 0) {
  throw "Packaged Windows startup smoke failed."
}

$BundledPython = Join-Path $ProjectRoot "resources\python-runtime-windows\venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $BundledPython -PathType Leaf)) {
  throw "The bundled Windows Python runtime is missing."
}

& $BundledPython -B -m unittest discover -s worker\windows_transformers\tests -v
if ($LASTEXITCODE -ne 0) {
  throw "Bundled Windows worker tests failed."
}

$PreviousPythonPath = $env:PYTHONPATH
try {
  $env:PYTHONPATH = Join-Path $ProjectRoot "worker\windows_transformers"
  & $BundledPython -B -c "import ctranslate2, faster_whisper, localscribe_windows_worker; print('Bundled Windows inference imports passed.')"
  if ($LASTEXITCODE -ne 0) {
    throw "Bundled Windows inference imports failed."
  }
  if ($RequireCuda -or -not [string]::IsNullOrWhiteSpace($CudaModelRoot)) {
    $CudaArguments = @("-B", "scripts\smoke-windows-cuda.py")
    if (-not [string]::IsNullOrWhiteSpace($CudaModelRoot)) {
      $CudaArguments += @("--model-root", $CudaModelRoot)
    }
    & $BundledPython @CudaArguments
    if ($LASTEXITCODE -ne 0) {
      throw "Windows CUDA smoke failed."
    }
  }
}
finally {
  $env:PYTHONPATH = $PreviousPythonPath
}

$CoreSbom = Join-Path $ProjectRoot "out\localscribe-core-runtime-windows-sbom.cdx.json"
$PythonSbom = Join-Path $ProjectRoot "out\localscribe-python-windows-sbom.cdx.json"
$CoreSbomText = (& npm.cmd run --silent sbom:runtime:windows) -join "`n"
if ($LASTEXITCODE -ne 0) {
  throw "Windows core-runtime SBOM generation failed."
}
[IO.File]::WriteAllText(
  $CoreSbom,
  "$CoreSbomText`n",
  [Text.UTF8Encoding]::new($false)
)
$PythonSbomText = (& npm.cmd run --silent sbom:python:windows) -join "`n"
if ($LASTEXITCODE -ne 0) {
  throw "Windows Python SBOM generation failed."
}
[IO.File]::WriteAllText(
  $PythonSbom,
  "$PythonSbomText`n",
  [Text.UTF8Encoding]::new($false)
)
foreach ($SbomPath in @($CoreSbom, $PythonSbom)) {
  $Sbom = Get-Content -LiteralPath $SbomPath -Raw | ConvertFrom-Json
  if ($Sbom.bomFormat -ne "CycloneDX" -or $Sbom.specVersion -notmatch "^1\.") {
    throw "Generated file is not a supported CycloneDX SBOM: $SbomPath"
  }
  if ($null -eq $Sbom.components -or @($Sbom.components).Count -lt 1) {
    throw "Generated SBOM has no components: $SbomPath"
  }
}

$SetupFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "out\make") -Recurse -File -Filter "*Setup.exe")
$PackageFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "out\make") -Recurse -File -Filter "*.nupkg")
$ReleaseFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "out\make") -Recurse -File -Filter "RELEASES")
if ($SetupFiles.Count -ne 1 -or $PackageFiles.Count -ne 1 -or $ReleaseFiles.Count -ne 1) {
  throw "Windows make must produce exactly one Setup.exe, one .nupkg, and one RELEASES file."
}

$PackagedApp = Join-Path $ProjectRoot "out\LocalScribe-win32-x64\LocalScribe.exe"
$PackagedHelper = Join-Path $ProjectRoot "out\LocalScribe-win32-x64\resources\native\windows\active-target.exe"
foreach ($RequiredBinary in @($PackagedApp, $PackagedHelper)) {
  if (-not (Test-Path -LiteralPath $RequiredBinary -PathType Leaf)) {
    throw "Required packaged Windows binary is missing: $RequiredBinary"
  }
}

$PublicRelease = $env:LOCALSCRIBE_RELEASE -eq "1"
$PackagedPeFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "out\LocalScribe-win32-x64") -Recurse -File |
    Where-Object { $_.Extension -in @(".exe", ".dll", ".node") } |
    ForEach-Object { $_.FullName }
)
$SignedCandidates = @($PackagedPeFiles + $SetupFiles[0].FullName | Sort-Object -Unique)
if ($SignedCandidates.Count -lt 3) {
  throw "Packaged Windows executable inventory is unexpectedly small."
}
foreach ($SignedCandidate in $SignedCandidates) {
  $Signature = Get-AuthenticodeSignature -LiteralPath $SignedCandidate
  if ($PublicRelease -and $Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Public Windows artifact has an invalid Authenticode signature: $SignedCandidate ($($Signature.Status))"
  }
  if (-not $PublicRelease -and $Signature.Status -notin @(
      [System.Management.Automation.SignatureStatus]::NotSigned,
      [System.Management.Automation.SignatureStatus]::Valid
    )) {
    throw "Windows validation artifact has an unexpected Authenticode status: $SignedCandidate ($($Signature.Status))"
  }
}

$ChecksumCandidates = @(
  $SetupFiles[0].FullName,
  $PackageFiles[0].FullName,
  $ReleaseFiles[0].FullName,
  $CoreSbom,
  $PythonSbom
)
$ChecksumPath = Join-Path $ProjectRoot "out\SHA256SUMS-windows.txt"
$OutRoot = (Resolve-Path -LiteralPath (Join-Path $ProjectRoot "out")).Path.TrimEnd("\")
$ChecksumLines = foreach ($Candidate in $ChecksumCandidates) {
  $ResolvedCandidate = (Resolve-Path -LiteralPath $Candidate).Path
  if (-not $ResolvedCandidate.StartsWith(
      "$OutRoot\",
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Checksum candidate is outside the output directory: $ResolvedCandidate"
  }
  $RelativeCandidate = $ResolvedCandidate.Substring($OutRoot.Length + 1)
  $Digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $ResolvedCandidate).Hash.ToLowerInvariant()
  "$Digest *$($RelativeCandidate.Replace('\', '/'))"
}
$ChecksumLines | Set-Content -LiteralPath $ChecksumPath -Encoding ascii

foreach ($Line in Get-Content -LiteralPath $ChecksumPath) {
  if ($Line -notmatch "^([a-f0-9]{64}) \*(.+)$") {
    throw "Malformed Windows checksum entry: $Line"
  }
  $ExpectedHash = $Matches[1]
  $RelativePath = $Matches[2].Replace("/", "\")
  $CandidatePath = Join-Path (Join-Path $ProjectRoot "out") $RelativePath
  $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CandidatePath).Hash.ToLowerInvariant()
  if ($ActualHash -ne $ExpectedHash) {
    throw "Windows checksum verification failed for $RelativePath"
  }
}

Write-Host "Complete local Windows verification passed."
