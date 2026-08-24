import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const projectFile = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

const smokeScript = projectFile("scripts/smoke-packaged-macos.sh");
const mainSource = projectFile("src/main.ts");
const resourceIntegritySource = projectFile("src/main/resourceIntegrity.ts");

/*
 * `smoke:packaged:macos` is the only gate that runs the real packaged binary,
 * so it must not be able to pass a build that cannot start. It previously
 * could, twice over: it scanned for an error string the product never emits,
 * and it inferred success from the process still being alive — but a startup
 * failure showed a modal NSAlert first, which blocks the main thread until
 * dismissed, so an unattended run always found a live process.
 */
describe("packaged macOS smoke gate cannot fail open", () => {
  it("does not scan for an error string the product never emits", () => {
    expect(smokeScript).not.toContain("resource integrity verification failed");
    const productSources = `${mainSource}${resourceIntegritySource}`;
    expect(productSources.toLowerCase()).not.toContain("resource integrity verification failed");
  });

  it("scans for the failure prefixes the product actually logs", () => {
    // Every startup rejection funnels through this one prefix, so it is the
    // load-bearing pattern; the resource-integrity alternation is redundancy.
    expect(mainSource).toContain('console.error("LocalScribe startup failed"');
    expect(smokeScript).toContain("LocalScribe startup failed");

    for (const emitted of ["rejected", "mismatch", "is missing", "found an unexpected", "detected"]) {
      expect(
        resourceIntegritySource,
        `resourceIntegrity.ts no longer emits "Resource integrity ${emitted}"`,
      ).toContain(`Resource integrity ${emitted}`);
      expect(smokeScript).toContain(emitted);
    }
  });

  it("requires a positive readiness signal rather than only liveness", () => {
    expect(smokeScript).toContain("localscribe-startup-ready");
    expect(smokeScript).toContain("never reported a completed startup");
    expect(mainSource).toContain('const SMOKE_READY_MARKER = "localscribe-startup-ready"');
    expect(mainSource).toContain("process.stdout.write(`${SMOKE_READY_MARKER}\\n`)");
  });

  it("runs the packaged binary with the flag that makes startup failure deterministic", () => {
    expect(smokeScript).toContain("LOCALSCRIBE_SMOKE=1");
    expect(mainSource).toContain('process.env.LOCALSCRIBE_SMOKE === "1"');
  });

  it("keeps the visible failure dialog for real users and suppresses it only under the flag", () => {
    const startupFailure = mainSource.slice(mainSource.indexOf("void startupPromise.then("));
    expect(startupFailure).toContain("if (!smokeMode) {");
    expect(startupFailure).toContain("dialog.showErrorBox(");
    expect(startupFailure).toContain("app.exit(1)");
  });

  it("requires every observed packaged Electron child to retire with the main process", () => {
    expect(smokeScript).toContain("capture_descendants");
    expect(smokeScript).toContain("tracked_processes_alive");
    expect(smokeScript).toContain(
      "Packaged macOS smoke could not enumerate the candidate process tree.",
    );
    expect(smokeScript).toContain(
      "Packaged macOS app left an observed child process running after shutdown.",
    );
    expect(smokeScript).toContain(
      "Packaged macOS main-process and observed-child shutdown smoke passed.",
    );
  });
});
