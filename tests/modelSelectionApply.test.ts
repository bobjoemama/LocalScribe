import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/main.ts", "utf8");

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("atomic model selection architecture", () => {
  it("orders unload, unbiased probe, resolution, verification, load, and persistence", () => {
    const body = between("async function applyModelSelection(", "function registerIpc(): void");
    const unload = body.indexOf("await worker.shutdown();");
    const probe = body.indexOf("await probeUnloadedAccelerator();", unload);
    const resolve = body.indexOf("targetResolution = resolveSelection", probe);
    const memory = body.indexOf("assertResolutionFitsMemory(targetResolution);", resolve);
    const verify = body.indexOf("await verifyRuntimeModelCatalog", memory);
    const load = body.indexOf("await worker.ensureReady(workerSelection(targetResolution.tier));", verify);
    const persist = body.indexOf("const latestSettings = database.getSettings();", load);
    const notify = body.indexOf("notifySettingsChanged(settings);", persist);

    const positions = [unload, probe, resolve, memory, verify, load, persist, notify];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps only an exact warm same-selection Apply idempotent and lets a cold selection load", () => {
    const body = between("async function applyModelSelection(", "function registerIpc(): void");
    const noOp = body.indexOf("workerModelSelectionsMatch(\n        currentWarmSelection");
    const firstUnload = body.indexOf("await worker.shutdown();");
    expect(noOp).toBeGreaterThanOrEqual(0);
    expect(noOp).toBeLessThan(firstUnload);
    expect(body).toContain("const currentResolutionForSelection = samePersistedSelection");
    expect(body).toContain("const previousWarmSelection = currentWarmSelection;");
    expect(body).toContain("else await worker.ensureReady(previousWarmSelection);");
    expect(body).toContain("modelResolution = previousResolution;");
  });

  it("merges routing into the latest settings row without an asynchronous lost-update window", () => {
    const body = between("async function applyModelSelection(", "function registerIpc(): void");
    const latestRead = body.indexOf("const latestSettings = database.getSettings();");
    const save = body.indexOf("const settings = database.saveSettings", latestRead);
    const latestMerge = body.indexOf("...latestSettings", latestRead);
    const saveEnd = body.indexOf("}));", latestMerge);

    expect(latestRead).toBeGreaterThanOrEqual(0);
    expect(save).toBeGreaterThan(latestRead);
    expect(latestMerge).toBeGreaterThan(latestRead);
    expect(latestMerge).toBeGreaterThan(save);
    expect(saveEnd).toBeGreaterThan(latestMerge);
    expect(body.slice(latestRead, saveEnd)).not.toContain("await ");
    expect(body.slice(latestRead, saveEnd)).toContain("activeModelFamilyId: request.familyId");
    expect(body.slice(latestRead, saveEnd)).toContain("modelPerformanceMode: request.performanceMode");
  });

  it("never restarts the rollback model while the application is shutting down", () => {
    const body = between("async function applyModelSelection(", "function registerIpc(): void");
    expect(body).toContain("if (quitting) restoreSkippedForShutdown = true;");
    expect(body).toContain("else await worker.ensureReady(previousWarmSelection);");
    expect(body).not.toContain("if (previousWarmSelection) await worker.ensureReady(previousWarmSelection);");
  });

  it("samples live Auto telemetry without unloading and normalizes the warm allocation", () => {
    const diagnostics = between(
      "async function collectDiagnosticsForResolution(",
      "async function collectDiagnostics():",
    );
    expect(diagnostics).not.toContain("worker.shutdown");
    expect(diagnostics).not.toContain("worker.deviceInfo");

    const listening = between("function beginListening(", "function finishListening(");
    expect(listening).toContain("refreshAutoResolutionAtRecordingBoundary()");
    expect(listening).not.toContain("worker.shutdown");

    const boundary = between(
      "async function refreshAutoResolutionAtRecordingBoundary()",
      "async function currentModelResolution()",
    );
    expect(boundary).toContain("const liveSnapshot = await worker.deviceInfo();");
    expect(boundary).toContain("memorySnapshotWithoutWarmModel(liveSnapshot, cached)");
    expect(boundary).toContain("return cached;");

    const normalization = between(
      "function memorySnapshotWithoutWarmModel(",
      "async function refreshAutoResolutionAtRecordingBoundary()",
    );
    expect(normalization).toContain("snapshot.freeMemoryBytes + warmResolution.tier.acceleratorMemory.minimumBytes");
    expect(normalization).toContain("Math.min(");
  });

  it("keeps model-library storage operations from silently changing the active runtime", () => {
    const ipc = between("function registerIpc(): void", "function createTray(): Tray");
    const install = between("handle(IPC.systemInstallModel", "handle(IPC.systemRemoveModel");
    expect(install).toContain("replacesLoadedArtifact");
    expect(install).toContain("workerModelSelectionsMatch(warmSelection, workerSelection(modelResolution.tier))");
    expect(install).toContain("worker.installModel(workerSelection(tier), { replacesLoadedArtifact })");

    const remove = between("handle(IPC.systemRemoveModel", "\n  });\n}");
    expect(remove).toContain("Apply another model or performance tier before removing it");
    expect(remove).not.toContain("worker.shutdown");
    expect(remove).not.toContain("modelResolution = null");
    expect(ipc).toContain("activeResolution.tier.artifactId === tier.artifactId");
  });

  it("retries missing accelerator telemetry only when idle and no model is warm", () => {
    const resolution = between(
      "async function currentModelResolution()",
      "function workerSelection(",
    );
    expect(resolution).toContain('session.state === "idle"');
    expect(resolution).toContain("acceleratorSnapshot === null");
    expect(resolution).toContain("worker.loadedSelection() === null");
    expect(resolution).toContain("refreshModelResolution({ reprobeUnloaded: true })");
  });

  it("registers only the strict combined Apply IPC", () => {
    const ipc = between("function registerIpc(): void", "function createTray(): Tray");
    expect(ipc).toContain("handle(IPC.systemApplyModelSelection");
    expect(ipc).toContain("modelSelectionApplyRequestSchema.parse(rawRequest)");
    expect(ipc).not.toContain("systemActivateModelFamily");
    const addFamily = between(
      "handle(IPC.systemAddModelFamily",
      "handle(IPC.systemApplyModelSelection",
    );
    expect(addFamily).toContain("return runExclusiveModelOperation(async () =>");
  });

  it("allows model mutation only in the literal idle session state", () => {
    const guard = between("function canSwitchModelNow(): boolean", "function assertModelSwitchAllowed(): void");
    expect(guard).toContain('return session.state === "idle";');
    expect(guard).not.toContain('session.state === "success"');
    expect(guard).not.toContain('session.state === "error"');
  });
});
