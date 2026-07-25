[CmdletBinding()]
param(
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $PSScriptRoot "active-target.exe"
}

function Assert-TrustedMicrosoftExecutable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
  if (
    $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    $null -eq $signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -notmatch "(^|,\s*)CN=Microsoft Corporation(,|$)"
  ) {
    throw "$Label must be a valid Microsoft-signed executable; refusing to execute $resolvedPath."
  }
  return $resolvedPath
}

function Import-X64VisualCppEnvironment {
  $programFilesX86 = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::ProgramFilesX86
  )
  $vswherePath = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
    return $false
  }
  $vswherePath = Assert-TrustedMicrosoftExecutable -Path $vswherePath -Label "vswhere.exe"

  $installationPaths = @(& $vswherePath `
    -all `
    -prerelease `
    -products * `
    -property installationPath)
  if ($LASTEXITCODE -ne 0) {
    return $false
  }

  $vcvarsPath = $null
  foreach ($installationPath in $installationPaths) {
    if ([string]::IsNullOrWhiteSpace($installationPath)) {
      continue
    }
    $candidate = Join-Path $installationPath.Trim() "VC\Auxiliary\Build\vcvars64.bat"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $vcvarsPath = $candidate
      break
    }
  }
  if ($null -eq $vcvarsPath) {
    return $false
  }

  $commandProcessor = Join-Path ([Environment]::SystemDirectory) "cmd.exe"
  if (-not (Test-Path -LiteralPath $commandProcessor -PathType Leaf)) {
    throw "The trusted Windows command processor was not found at $commandProcessor."
  }
  $commandProcessor = Assert-TrustedMicrosoftExecutable `
    -Path $commandProcessor `
    -Label "cmd.exe"
  $environmentLines = & $commandProcessor /d /s /c "call `"$vcvarsPath`" >nul && set"
  if ($LASTEXITCODE -ne 0) {
    throw "Visual Studio's vcvars64.bat failed with exit code $LASTEXITCODE."
  }
  foreach ($line in $environmentLines) {
    $separator = $line.IndexOf("=")
    if ($separator -le 0) {
      continue
    }
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
  return $true
}

function Resolve-TrustedMicrosoftBuildTool {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $null
  }
  return Assert-TrustedMicrosoftExecutable -Path $command.Source -Label $Name
}

# MSVC honors these ambient variables as implicit arguments and search paths.
# Clear them before vcvars builds the release environment so a caller profile
# or CI runner cannot inject response files, headers, libraries, or output
# paths into the signed compiler/linker invocation.
foreach ($injectedVariable in @(
    "CL",
    "_CL_",
    "LINK",
    "_LINK_",
    "INCLUDE",
    "LIB",
    "LIBPATH"
  )) {
  [Environment]::SetEnvironmentVariable($injectedVariable, $null, "Process")
}

if (-not (Import-X64VisualCppEnvironment)) {
  throw "Visual Studio Build Tools 2022 or newer with the Desktop development with C++ workload was not found."
}
# vcvars is trusted installation metadata, but the batch file can inherit or
# emit MSVC's implicit-argument variables. Clear argument injection again
# after import while retaining the INCLUDE/LIB toolchain paths it established.
foreach ($injectedArgumentVariable in @("CL", "_CL_", "LINK", "_LINK_")) {
  [Environment]::SetEnvironmentVariable($injectedArgumentVariable, $null, "Process")
}
$compilerPath = Resolve-TrustedMicrosoftBuildTool -Name "cl.exe"
if ($null -eq $compilerPath) {
  throw "cl.exe was not found. Install Visual Studio Build Tools 2022 or newer with the Desktop development with C++ workload."
}
$linkerPath = Resolve-TrustedMicrosoftBuildTool -Name "link.exe"
if ($null -eq $linkerPath) {
  throw "link.exe was not found. Install Visual Studio Build Tools 2022 or newer with the Desktop development with C++ workload."
}

$sourcePath = Join-Path $PSScriptRoot "active-target.cpp"
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "The helper source file was not found at $sourcePath."
}
$absoluteOutputPath = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($absoluteOutputPath) -ne ".exe") {
  throw "The helper output path must end in .exe."
}
if ($absoluteOutputPath.Equals(
    [IO.Path]::GetFullPath($sourcePath),
    [StringComparison]::OrdinalIgnoreCase
  )) {
  throw "The helper output path must not overwrite its source file."
}
$outputDirectory = Split-Path -Parent $absoluteOutputPath
if (Test-Path -LiteralPath $outputDirectory) {
  $outputDirectoryItem = Get-Item -LiteralPath $outputDirectory -Force
  if (
    -not $outputDirectoryItem.PSIsContainer -or
    ($outputDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "The helper output directory must be a regular directory, not a reparse point."
  }
}
else {
  [void](New-Item -ItemType Directory -Path $outputDirectory)
}
if (Test-Path -LiteralPath $absoluteOutputPath) {
  $existingOutput = Get-Item -LiteralPath $absoluteOutputPath -Force
  if (
    $existingOutput.PSIsContainer -or
    ($existingOutput.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "The helper output must be a regular file, not a directory or reparse point."
  }
}

$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("localscribe-active-target-" + [Guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $temporaryDirectory)

try {
  $objectPath = Join-Path $temporaryDirectory "active-target.obj"
  $compilerArguments = @(
    "/nologo",
    "/std:c++17",
    "/O2",
    "/EHsc",
    "/W4",
    "/WX",
    "/analyze",
    "/permissive-",
    "/sdl",
    "/GS",
    "/guard:cf",
    "/utf-8",
    "/DUNICODE",
    "/D_UNICODE",
    "/Fo:$objectPath",
    "/Fe:$absoluteOutputPath",
    $sourcePath,
    "/link",
    "bcrypt.lib",
    "ole32.lib",
    "oleaut32.lib",
    "uiautomationcore.lib",
    "user32.lib",
    "/MACHINE:X64",
    "/DYNAMICBASE",
    "/HIGHENTROPYVA",
    "/NXCOMPAT",
    "/guard:cf",
    "/CETCOMPAT",
    "/DEPENDENTLOADFLAG:0x800",
    "/OPT:REF",
    "/OPT:ICF"
  )

  # Compile from the private temporary directory. This keeps the source tree
  # out of the DLL/tool discovery current-directory slot while cl.exe invokes
  # its signed Microsoft compiler and linker components.
  Push-Location -LiteralPath $temporaryDirectory
  try {
    & $compilerPath @compilerArguments
    if ($LASTEXITCODE -ne 0) {
      throw "MSVC failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }
  if (-not (Test-Path -LiteralPath $absoluteOutputPath -PathType Leaf)) {
    throw "MSVC reported success but did not create $absoluteOutputPath."
  }

  # This command is deterministic and does not require an interactive desktop,
  # so it remains a useful compile/link smoke test on headless Windows CI.
  $selfTest = (& $absoluteOutputPath self-test | ConvertFrom-Json)
  if (
    $LASTEXITCODE -ne 0 -or
    $selfTest.platform -ne "win32" -or
    $selfTest.architecture -ne "x64" -or
    $selfTest.selfTest -ne $true
  ) {
    throw "The helper self-test returned an invalid payload."
  }

  $clipboard = (& $absoluteOutputPath clipboard-sequence | ConvertFrom-Json)
  if (
    $LASTEXITCODE -ne 0 -or
    $clipboard.platform -ne "win32" -or
    $null -eq $clipboard.sequence -or
    [int64]$clipboard.sequence -le 0
  ) {
    throw "The clipboard-sequence command returned an invalid payload."
  }

  # GetForegroundWindow can legitimately be null in a non-interactive CI
  # session. When a desktop is available, validate the live target contract;
  # otherwise the deterministic self-test above remains the build gate.
  $targetJson = & $absoluteOutputPath target 2>$null
  $targetExitCode = $LASTEXITCODE
  if ($targetExitCode -eq 0) {
    $target = ($targetJson | ConvertFrom-Json)
    if (
      $target.platform -ne "win32" -or
      [int64]$target.processId -le 0 -or
      [string]::IsNullOrWhiteSpace([string]$target.applicationId) -or
      [string]$target.windowFingerprint -notmatch "^[a-f0-9]{64}$" -or
      $target.focusedEditable -isnot [bool]
    ) {
      throw "The target command returned an invalid payload."
    }
  }

  Write-Host "Built and smoke-tested Windows x64 helper: $absoluteOutputPath"
}
finally {
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
