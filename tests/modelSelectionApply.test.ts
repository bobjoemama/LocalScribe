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
  it("proves the exact target before unload, then probes, loads, and persists it", () => {
    const body = between("async function applyModelSelection(", "function registerIpc(): void");
    const resolve = body.indexOf("targetResolution = resolveModelPerformance");
    const memory = body.indexOf("assertResolutionFitsMemory(targetResolution);", resolve);
    // Only the artifact being loaded gates the Apply; the other tiers of the
    // family cannot change the outcome and hashing them cost gigabytes of reads.
    const verify = body.indexOf("await verifyModelDirectory(modelRoot, targetResolution.tier.manifest)", memory);
    expect(body).not.toContain("verifyRuntimeModelCatalog");
    const unload = body.indexOf("await worker.shutdown();", verify);
    const probe = body.indexOf("await probeUnloadedAccelerator();", unload);
    const load = body.indexOf("await worker.ensureReady(workerSelection(targetResolution.tier, request.asrMode));", probe);
    const persist = body.indexOf("const latestSettings = database.getSettings();", load);
    const notify = body.indexOf("notifySettingsChanged(settings);", persist);

    const positions = [resolve, memory, verify, unload, probe, load, persist, notify];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("does not unload the warm model when target preflight fails", () => {
    const body = between("async function applyModelSelection(", "function registerIpc(): void");
    const verification = body.indexOf("await verifyModelDirectory(modelRoot, targetResolution.tier.manifest)");
    const transition = body.indexOf("runtimeTransitionStarted = true;", verification);
    const unload = body.indexOf("await worker.shutdown();", transition);
    const catchStart = body.indexOf("} catch (error) {", unload);
    const catchEnd = body.indexOf("throw new Error(`Could not apply", catchStart);
    const rollback = body.slice(catchStart, catchEnd);

    expect(verification).toBeGreaterThanOrEqual(0);
    expect(transition).toBeGreaterThan(verification);
    expect(unload).toBeGreaterThan(transition);
    expect(rollback).toContain("if (runtimeTransitionStarted)");
    expect(rollback).toContain("The previous model was never unloaded");
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

  it("returns an explicit confirmation only for the exact loaded artifact", () => {
    const body = between("async function applyModelSelection(", "function registerIpc(): void");
    expect(body).toContain("applied: true,");
    expect(body).toContain("appliedSelection:");
    expect(body).toContain("artifactId: targetResolution.tier.artifactId");
    expect(body).toContain("artifactId: currentResolutionForSelection.tier.artifactId");
    expect(body).toContain("tier: targetResolution.effectiveTier");
  });

  it("rejects an incompatible saved language before the target can unload", () => {
    const body = between("async function applyModelSelection(", "function registerIpc(): void");
    const languageGate = body.indexOf("assertModelLanguageSupported(\n      previousSettings.language");
    const unload = body.indexOf("await worker.shutdown();");

    expect(languageGate).toBeGreaterThanOrEqual(0);
    expect(unload).toBeGreaterThan(languageGate);
    expect(body).toContain("targetCatalog.capabilities");
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
    expect(body.slice(latestRead, saveEnd)).toContain("asrMode: request.asrMode");
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
    /*
     * Auto is a memory-only policy, so a drift between dictations can land on a
     * tier in the same family that was never downloaded. Switching kills the
     * worker process before the load discovers the artifact is missing, so the
     * user loses both the warm model and the dictation. The boundary must keep
     * the warm tier instead.
     */
    expect(boundary).toContain("next.effectiveTier !== cached.effectiveTier");
    /*
     * This asserted `modelArtifactIsPresent(` while that function was still a
     * size-only probe. A corrupted-in-place artifact keeps its size, so the
     * guard passed, the warm model was killed by the switch, and the load then
     * failed on the digest — costing the user both the model and the dictation.
     * The guard now demands proof at the artifact's current file identity, and
     * the weaker predicate must not come back here.
     */
    expect(boundary).toContain("modelArtifactIsVerifiedNow(");
    expect(boundary).not.toContain("modelArtifactIsPresent(");

    const normalization = between(
      "function memorySnapshotWithoutWarmModel(",
      "async function refreshAutoResolutionAtRecordingBoundary()",
    );
    expect(normalization).toContain("snapshot.freeMemoryBytes + warmResolution.tier.acceleratorMemory.minimumBytes");
    expect(normalization).toContain("Math.min(");
  });

  /*
   * `worker.abort()` kills the worker process, so it discards the warm model.
   * Cancel used to call it from "finalizing" and "inserting" too, where no
   * transcribe request is in flight — the renderer is still encoding audio, or
   * the worker has already returned — so pressing the pill's X cost a
   * multi-gigabyte reload for nothing.
   */
  it("only kills the worker on cancel when a transcribe request is in flight", () => {
    const cancel = between("handle(IPC.sessionCancel", "handle(IPC.sessionFail");
    expect(cancel).toContain("insertion.cancelSession();");
    expect(cancel).toContain('if (session.state === "transcribing") {');
    expect(cancel).toContain('worker.abort("Dictation was cancelled")');
    expect(cancel).not.toContain('session.state === "finalizing"');
    expect(cancel).not.toContain('session.state === "inserting"');
    expect(cancel).toContain('setSession({ state: "idle" })');
  });

  it("invalidates Live state before queued worker cleanup so cancel never waits on append", () => {
    const cancelLive = between("handle(IPC.sessionCancelLive", "handle(IPC.sessionTranscribe");
    expect(cancelLive).toContain("activeLiveSession = null;");
    expect(cancelLive).toContain("scheduleLiveWorkerCancellation(request.sessionId);");
    expect(cancelLive).toContain('return setSession({ state: "idle" });');
    expect(cancelLive).not.toContain("await worker.cancelLiveSession");
    const helper = between("function scheduleLiveWorkerCancellation(", "/** Deliver a validated install/repair event");
    expect(helper).toContain("void worker.cancelLiveSession(sessionId)");
  });

  it("delivers Live partials only for the active listening session", () => {
    const partial = between("function notifyLivePartial(", "function completeDictationFinal(");
    expect(partial).toContain("live.sessionId !== partial.sessionId");
    expect(partial).toContain('session.state !== "listening"');
    expect(partial).toContain("session.sessionId !== partial.sessionId");
    expect(partial).toContain("activeSessionId !== partial.sessionId");
    expect(partial).toContain("pillWindow.webContents.send(IPC.sessionLivePartial, partial)");
  });

  it("uses model capabilities to suppress unsupported recognizer context", () => {
    const transcription = between("handle(IPC.sessionTranscribe", "handle(IPC.historyList");
    expect(transcription).toContain("dictionaryAsrContextForCapabilities(");
    expect(transcription).toContain("modelCatalog(resolution.tier.familyId).capabilities");
  });

  it("keeps model-library storage operations from silently changing the active runtime", () => {
    const ipc = between("function registerIpc(): void", "function createTray(): Tray");
    const install = between("handle(IPC.systemInstallModel", "handle(IPC.systemRemoveModel");
    expect(install).toContain("replacesLoadedArtifact");
    expect(install).toContain("workerSelection(modelResolution.tier, currentSettings.asrMode)");
    expect(install).toContain("install: () => {");
    expect(install).toContain("return worker.installModel(workerSelection(");
    expect(install).toContain("replacesLoadedArtifact,");
    // The install request budget scales with the artifact, so the size has to
    // reach the supervisor with the request. See tests/workerSupervisor.test.ts.
    expect(install).toContain("const artifactBytes = Object.values(tier.manifest.files)");
    expect(install).toContain("artifactBytes,");

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
