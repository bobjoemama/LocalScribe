import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const verifier = readFileSync(
  resolve(process.cwd(), "scripts/verify-local-windows.ps1"),
  "utf8",
).replace(/\r\n?/gu, "\n");

describe("complete Windows verifier command resolution", () => {
  it("uses only absolute regular files inherited from the pinned npm lifecycle", () => {
    expect(verifier).toContain(
      'Resolve-RequiredNpmLifecyclePath `\n  -VariableName "npm_node_execpath" `\n  -ExpectedLeafName "node.exe"',
    );
    expect(verifier).toContain(
      'Resolve-RequiredNpmLifecyclePath `\n  -VariableName "npm_execpath" `\n  -ExpectedLeafName "npm-cli.js"',
    );
    expect(verifier).toContain("[IO.Path]::IsPathRooted($CandidatePath)");
    expect(verifier).toContain("[IO.Path]::GetFullPath($CandidatePath)");
    expect(verifier).toContain(
      "Microsoft.PowerShell.Management\\Get-Item `",
    );
    expect(verifier).toContain("[IO.FileAttributes]::ReparsePoint");
    expect(verifier).not.toContain("Get-Command");
  });

  it("cannot route Node or npm through a profile alias, function, or script shim", () => {
    expect(verifier.match(/& \$NodeExecutable \$NpmCli\b/gu)).toHaveLength(5);
    expect(verifier).toContain(
      "& $NodeExecutable scripts/release-metadata.mjs",
    );
    expect(verifier).toContain("& $NodeExecutable --version");
    expect(verifier).toContain(
      "& $NodeExecutable scripts/verify-release-assets.mjs",
    );
    expect(verifier).not.toMatch(
      /^\s*(?:node(?:\.exe)?|npm(?:\.cmd|\.ps1)?)\s/imu,
    );
    expect(verifier).not.toMatch(
      /&\s+(?:node(?:\.exe)?|npm(?:\.cmd|\.ps1)?)\b/iu,
    );
    expect(verifier).not.toContain("npm.cmd");
  });

  it("preserves native exit-code gates around every Node and npm operation", () => {
    const invocations = verifier.match(
      /(?:\(& \$NodeExecutable[^)]*\)|^& \$NodeExecutable[^\n]*)/gmu,
    );
    const exitChecks = verifier.match(
      /\$LASTEXITCODE -ne 0/gmu,
    );

    expect(invocations).toHaveLength(8);
    expect(exitChecks?.length).toBeGreaterThanOrEqual(invocations?.length ?? 0);
    expect(verifier).toContain(
      "$LASTEXITCODE -ne 0 -or $ActualNodeVersion -ne $ExpectedNodeVersion",
    );
  });
});
