[CmdletBinding()]
param(
  [switch]$RequireCuda,
  [string]$CudaModelRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-RequiredNpmLifecyclePath {
  param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$VariableName,
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpectedLeafName
  )

  $CandidatePath = [Environment]::GetEnvironmentVariable($VariableName)
  if (
    [string]::IsNullOrWhiteSpace($CandidatePath) -or
    -not [IO.Path]::IsPathRooted($CandidatePath)
  ) {
    throw "Complete local Windows verification must run through a pinned npm script."
  }
  $ResolvedPath = [IO.Path]::GetFullPath($CandidatePath)
  if (
    -not $ResolvedPath.Equals($CandidatePath, [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFileName($ResolvedPath).Equals(
      $ExpectedLeafName,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Pinned npm lifecycle path is unexpected: $VariableName"
  }
  $ResolvedItem = Microsoft.PowerShell.Management\Get-Item `
    -LiteralPath $ResolvedPath `
    -Force `
    -ErrorAction Stop
  if (
    $ResolvedItem.PSIsContainer -or
    ($ResolvedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "Pinned npm lifecycle path is not a regular file: $VariableName"
  }
  return $ResolvedItem.FullName
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "Complete local Windows verification requires Windows."
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
  throw "Complete local Windows verification requires an x64 host."
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$NodeExecutable = Resolve-RequiredNpmLifecyclePath `
  -VariableName "npm_node_execpath" `
  -ExpectedLeafName "node.exe"
$NpmCli = Resolve-RequiredNpmLifecyclePath `
  -VariableName "npm_execpath" `
  -ExpectedLeafName "npm-cli.js"
$ReleaseJson = (& $NodeExecutable scripts/release-metadata.mjs --platform win32 --format json) -join "`n"
if ($LASTEXITCODE -ne 0) {
  throw "Windows release metadata resolution failed."
}
$Release = $ReleaseJson | ConvertFrom-Json
if ($Release.arch -ne "x64") {
  throw "Windows release metadata must target x64."
}

$ExpectedNodeVersion = (Get-Content -LiteralPath (Join-Path $ProjectRoot ".nvmrc") -Raw).Trim()
$ExpectedNodeVersion = $ExpectedNodeVersion.TrimStart([char]"v")
$ActualNodeVersion = (& $NodeExecutable --version).Trim().TrimStart([char]"v")
if ($LASTEXITCODE -ne 0 -or $ActualNodeVersion -ne $ExpectedNodeVersion) {
  throw "Node version mismatch: expected $ExpectedNodeVersion, received $ActualNodeVersion."
}

& $NodeExecutable $NpmCli run verify:local
if ($LASTEXITCODE -ne 0) {
  throw "Local source verification failed."
}

& $NodeExecutable $NpmCli run make:windows
if ($LASTEXITCODE -ne 0) {
  throw "Windows packaging failed."
}

& $NodeExecutable $NpmCli run smoke:packaged:windows
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

$CoreSbom = $Release.coreSbomPath
$PythonSbom = $Release.pythonSbomPath
$CoreSbomText = (& $NodeExecutable $NpmCli run --silent sbom:runtime:windows) -join "`n"
if ($LASTEXITCODE -ne 0) {
  throw "Windows core-runtime SBOM generation failed."
}
[IO.File]::WriteAllText(
  $CoreSbom,
  "$CoreSbomText`n",
  [Text.UTF8Encoding]::new($false)
)
$PythonSbomText = (& $NodeExecutable $NpmCli run --silent sbom:python:windows) -join "`n"
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

$ExpectedPortablePaths = @($Release.primaryArtifactPaths | ForEach-Object {
  [IO.Path]::GetFullPath([string]$_)
})
if ($ExpectedPortablePaths.Count -ne 1) {
  throw "Windows release metadata must define exactly one portable ZIP."
}
$PortableFiles = @(
  Get-ChildItem -LiteralPath $Release.makerDirectory -File |
    Where-Object { $_.Extension -eq ".zip" }
)
if ($PortableFiles.Count -ne 1) {
  throw "Windows make must produce exactly one verified portable ZIP."
}
$PortablePath = [IO.Path]::GetFullPath($PortableFiles[0].FullName)
if (
  -not $PortablePath.Equals(
    $ExpectedPortablePaths[0],
    [StringComparison]::OrdinalIgnoreCase
  ) -or
  ($PortableFiles[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
  $PortableFiles[0].Length -le 0
) {
  throw "Windows make produced an unexpected, empty, or reparse-point portable ZIP."
}
$UnsupportedSquirrelFiles = @(
  Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "out\make") -Recurse -File |
    Where-Object {
      $_.Name -match "Setup\.exe$" -or
      $_.Extension -eq ".nupkg" -or
      $_.Name -eq "RELEASES"
    }
)
if ($UnsupportedSquirrelFiles.Count -ne 0) {
  throw "Default Windows verification must not publish unsupported Squirrel artifacts."
}

$PackagedApp = $Release.applicationPath
$PackagedRoot = $Release.packageDirectory
$PackagedHelper = Join-Path $PackagedRoot "resources\native\windows\active-target.exe"
foreach ($RequiredBinary in @($PackagedApp, $PackagedHelper)) {
  if (-not (Test-Path -LiteralPath $RequiredBinary -PathType Leaf)) {
    throw "Required packaged Windows binary is missing: $RequiredBinary"
  }
}

$PublicRelease = $env:LOCALSCRIBE_RELEASE -eq "1"
$PackagedPeFiles = @(
  Get-ChildItem -LiteralPath $PackagedRoot -Recurse -File |
    Where-Object { $_.Extension -in @(".exe", ".dll", ".node") } |
    ForEach-Object { $_.FullName }
)
$SignedCandidates = @($PackagedPeFiles | Sort-Object -Unique)
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
  $PortablePath,
  $CoreSbom,
  $PythonSbom
)
$ChecksumPath = $Release.checksumPath
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

& $NodeExecutable scripts/verify-release-assets.mjs --platform win32 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Windows release asset verification failed."
}

Write-Host "Complete local Windows verification passed for $($Release.productName) $($Release.version)."
