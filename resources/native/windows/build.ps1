[CmdletBinding()]
param(
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $PSScriptRoot "active-target.exe"
}

function Import-X64VisualCppEnvironment {
  $vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
    return $false
  }

  $installationPath = (& $vswherePath `
    -latest `
    -prerelease `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installationPath)) {
    return $false
  }

  $vcvarsPath = Join-Path $installationPath.Trim() "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path -LiteralPath $vcvarsPath -PathType Leaf)) {
    return $false
  }

  $environmentLines = & $env:ComSpec /d /s /c "call `"$vcvarsPath`" >nul && set"
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

$compiler = Get-Command "cl.exe" -ErrorAction SilentlyContinue
if ($null -eq $compiler -or $env:VSCMD_ARG_TGT_ARCH -ne "x64") {
  [void](Import-X64VisualCppEnvironment)
  $compiler = Get-Command "cl.exe" -ErrorAction SilentlyContinue
}
if ($null -eq $compiler) {
  throw "cl.exe was not found. Install Visual Studio Build Tools 2022 or newer with the Desktop development with C++ workload."
}

$sourcePath = Join-Path $PSScriptRoot "active-target.cpp"
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "The helper source file was not found at $sourcePath."
}
$absoluteOutputPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $absoluteOutputPath
[void](New-Item -ItemType Directory -Force -Path $outputDirectory)

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
    "/NXCOMPAT",
    "/guard:cf",
    "/CETCOMPAT",
    "/OPT:REF",
    "/OPT:ICF"
  )

  & $compiler.Source @compilerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "MSVC failed with exit code $LASTEXITCODE."
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
    $null -eq $clipboard.sequence -or
    [int64]$clipboard.sequence -lt 0
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
