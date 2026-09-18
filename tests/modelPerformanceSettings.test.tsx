import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModelCapabilities, ModelCatalog } from "../src/shared/contracts";
import {
  modelApplyEligibility,
  modelActionProgressPresentation,
  modelFamilyPresentation,
  ModelPerformanceSettings,
  supportedModeChoices,
  type ModelPerformanceSettingsProps,
} from "../src/renderer/settings/screens/ModelPerformanceSettings";

const GIBIBYTE = 1_073_741_824;
const qwenPrecisions = ["bf16", "8-bit", "4-bit"] as const;
const afterStopCapabilities: ModelCapabilities = {
  modes: ["after-stop"],
  partialResults: false,
  timestamps: false,
  languageDetection: true,
  promptContext: true,
  keywordBoost: false,
  supportedLanguages: ["auto", "en", "es", "fr", "de", "hi"],
};

function catalog({
  sharedPrimaryArtifact = false,
  sharedSecondaryArtifact = false,
  secondaryInLibrary = false,
  activeFamilyId = "qwen3-asr-0-6b",
}: {
  sharedPrimaryArtifact?: boolean;
  sharedSecondaryArtifact?: boolean;
  secondaryInLibrary?: boolean;
  activeFamilyId?: ModelCatalog["activeModelFamilyId"];
} = {}): ModelCatalog {
  // Shared artifacts are deliberately synthetic: shipped Qwen tiers each have
  // distinct weights. These switches exercise generic artifact deduplication.
  const primaryArtifactId = sharedPrimaryArtifact ? "synthetic-qwen3-asr-0-6b-shared" : undefined;
  const secondaryIsInLibrary = secondaryInLibrary || activeFamilyId === "qwen3-asr-1-7b";
  const backend = "MLX Audio";
  const primaryArtifacts = sharedPrimaryArtifact
    ? [{
      artifactId: primaryArtifactId!,
      displayName: "Synthetic Qwen3-ASR 0.6B shared artifact",
      backend,
      modelId: "curated/qwen3-asr-0-6b",
      storageDirectory: "qwen3-asr-0-6b",
      revision: "a".repeat(40),
      license: "Apache-2.0",
      expectedDownloadBytes: 3_000_000_000,
    }]
    : ["high", "medium", "low"].map((tier, index) => ({
      artifactId: `qwen3-asr-0-6b-${tier}`,
      displayName: `Qwen3-ASR 0.6B ${tier}`,
      backend,
      modelId: `curated/qwen3-asr-0-6b-${tier}`,
      storageDirectory: `qwen3-asr-0-6b-${tier}`,
      revision: `${index + 1}`.repeat(40),
      license: "Apache-2.0",
      expectedDownloadBytes: (3 - index) * 1_000_000_000,
    }));
  const profiles = ["high", "medium", "low"] as const;
  const secondaryArtifacts = (sharedSecondaryArtifact ? ["shared"] : ["bf16", "8bit", "4bit"])
    .map((precision, index) => ({
      artifactId: sharedSecondaryArtifact ? "synthetic-qwen3-asr-1-7b-shared" : `qwen3-asr-1-7b-mlx-${precision}`,
      displayName: sharedSecondaryArtifact ? "Synthetic Qwen3-ASR 1.7B shared artifact" : `Qwen3-ASR 1.7B · MLX ${precision}`,
      backend,
      modelId: `curated/qwen3-asr-1-7b-${precision}`,
      storageDirectory: `qwen3-asr-1-7b-${precision}`,
      revision: `${index + 4}`.repeat(40),
      license: "Apache-2.0",
      expectedDownloadBytes: (3 - index) * 1_000_000_000,
    }));
  return {
    platform: "darwin-arm64",
    activeModelFamilyId: activeFamilyId,
    recommendedDefaultFamilyId: "qwen3-asr-0-6b",
    modelLibraryFamilyIds: secondaryIsInLibrary ? ["qwen3-asr-0-6b", "qwen3-asr-1-7b"] : ["qwen3-asr-0-6b"],
    families: [
      {
        familyId: "qwen3-asr-0-6b",
        displayName: "Qwen3-ASR 0.6B",
        capabilities: afterStopCapabilities,
        recommendedDefault: true,
        active: activeFamilyId === "qwen3-asr-0-6b",
        inLibrary: true,
        artifacts: primaryArtifacts,
        profiles: profiles.map((tier, index) => ({
          profileId: `primary-${tier}`,
          tier,
          artifactId: primaryArtifactId ?? `qwen3-asr-0-6b-${tier}`,
          engine: "mlx-audio",
          precision: qwenPrecisions[index]!,
          expectedMemoryMinBytes: (3 - index) * GIBIBYTE,
          expectedMemoryMaxBytes: (4 - index) * GIBIBYTE,
          memoryBasis: "estimated",
        })),
      },
      {
        familyId: "qwen3-asr-1-7b",
        displayName: "Qwen3-ASR 1.7B",
        capabilities: afterStopCapabilities,
        recommendedDefault: false,
        active: activeFamilyId === "qwen3-asr-1-7b",
        inLibrary: secondaryIsInLibrary,
        artifacts: secondaryArtifacts,
        profiles: profiles.map((tier, index) => ({
          profileId: `secondary-${tier}`,
          tier,
          artifactId: secondaryArtifacts[sharedSecondaryArtifact ? 0 : index]!.artifactId,
          engine: "mlx-audio",
          precision: qwenPrecisions[index]!,
          expectedMemoryMinBytes: (3 - index) * GIBIBYTE,
          expectedMemoryMaxBytes: (4 - index) * GIBIBYTE,
          memoryBasis: "estimated",
        })),
      },
    ],
    verifications: [
      ...primaryArtifacts.map((artifact) => ({
        familyId: "qwen3-asr-0-6b" as const,
        artifactId: artifact.artifactId,
        present: false,
        verified: false,
        verificationStatus: "missing" as const,
        sizeBytes: 0,
        expectedBytes: artifact.expectedDownloadBytes,
        verifiedFiles: 0,
        expectedFiles: 1,
      })),
      ...secondaryArtifacts.map((artifact) => ({
        familyId: "qwen3-asr-1-7b" as const,
        artifactId: artifact.artifactId,
        present: false,
        verified: false,
        verificationStatus: "missing" as const,
        sizeBytes: 0,
        expectedBytes: artifact.expectedDownloadBytes,
        verifiedFiles: 0,
        expectedFiles: 1,
      })),
    ],
    unmanagedEntries: [],
  };
}

function renderModelSettings(overrides: Partial<ModelPerformanceSettingsProps> = {}) {
  const props: ModelPerformanceSettingsProps = {
    currentSelection: {
      familyId: "qwen3-asr-0-6b",
      asrMode: "after-stop",
      performanceMode: "auto",
    },
    currentModelLoaded: true,
    pendingSelection: {
      familyId: "qwen3-asr-0-6b",
      asrMode: "after-stop",
      performanceMode: "auto",
    },
    mode: "auto",
    resolvedTier: "medium",
    fitsMemoryBudget: true,
    resolutionReason: "Medium fits the currently reported unified memory.",
    hardware: {
      platform: "darwin",
      displayName: "Apple M-series GPU",
      totalMemoryBytes: 48 * GIBIBYTE,
      availableMemoryBytes: 31 * GIBIBYTE,
      memoryBasis: "measured",
    },
    memoryRequirement: {
      requiredFreeMemoryBytes: 9 * GIBIBYTE,
      reservedHeadroomBytes: 2 * GIBIBYTE,
    },
    catalog: catalog(),
    catalogError: null,
    runtimeTierStatuses: [
      {
        familyId: "qwen3-asr-0-6b",
        tier: "high",
        artifactId: "qwen3-asr-0-6b-high",
        qualityNote: "Highest local transcription quality.",
        verificationStatus: "missing",
      },
      {
        familyId: "qwen3-asr-0-6b",
        tier: "medium",
        artifactId: "qwen3-asr-0-6b-medium",
        qualityNote: "Balanced quality and memory use.",
        verificationStatus: "verified",
      },
      {
        familyId: "qwen3-asr-0-6b",
        tier: "low",
        artifactId: "qwen3-asr-0-6b-low",
        qualityNote: "Lowest memory use.",
        verificationStatus: "invalid",
      },
    ],
    action: null,
    feedback: null,
    applying: false,
    refreshing: false,
    residentRuntimeLabel: "Qwen3-ASR 0.6B medium",
    onModeChange: vi.fn(),
    onFamilyChange: vi.fn(),
    onApply: vi.fn(),
    onInstall: vi.fn(),
    onRepair: vi.fn(),
    onRemove: vi.fn(),
    onAddFamily: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<ModelPerformanceSettings {...props} />);
}

/** The opening tag of the single Apply button, so its state can be read. */
function applyButtonTag(html: string): string {
  const start = html.lastIndexOf("<button", html.indexOf("ls-model-apply-button"));
  expect(start, "no Apply button in the rendered screen").toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf(">", start) + 1);
}

/** Every Download / Repair / Remove button in the model library. */
function storageButtonTags(html: string): string[] {
  return [...html.matchAll(/<button[^>]*aria-label="(?:Download|Repair|Remove|Check \/ download)[^"]*"[^>]*>/gu)]
    .map((match) => match[0]);
}

describe("ModelPerformanceSettings", () => {
  it.each(["whisper-large-v2", "whisper-large-v3"] as const)("explains retired %s while allowing an explicit supported replacement", (familyId) => {
    const reduced = catalog({ activeFamilyId: familyId });
    reduced.modelLibraryFamilyIds.push(familyId);
    reduced.families = reduced.families
      .map((family) => ({ ...family, profiles: family.profiles.filter((profile) => profile.tier === "high") }));
    const html = renderModelSettings({
      catalog: reduced,
      currentSelection: { familyId, asrMode: "after-stop", performanceMode: "high" },
      pendingSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "high" },
      currentModelLoaded: false,
      mode: "high",
      resolvedTier: null,
      residentRuntimeLabel: null,
      runtimeTierStatuses: [{ familyId: "qwen3-asr-0-6b", tier: "high", artifactId: "qwen3-asr-0-6b-high",
        qualityNote: "Original precision", verificationStatus: "verified" }],
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Your saved selection and model files have not been changed");
    expect(html).not.toMatch(/<h3>Whisper|aria-label="(?:Download|Repair|Remove)[^"]*whisper/);
    expect(applyButtonTag(html)).toContain('aria-disabled="false"');
    expect(supportedModeChoices(reduced.families[0]).map((choice) => choice.id)).toEqual(["auto", "high"]);
    expect(supportedModeChoices(undefined)).toEqual([]);
  });

  it("puts status first and collapses secondary details without hiding the selected profiles", () => {
    const html = renderModelSettings();
    expect(html).toMatch(/^<div class="ls-model-performance"><section class="ls-model-apply-card"/);
    expect(html).toContain('<details class="ls-model-selection-details">');
    expect(html).toContain('<details class="ls-model-hardware-details">');
    expect(html.match(/<details class="ls-model-profiles" open=""/g)).toHaveLength(1);
    expect(html).toContain('<details class="ls-model-profiles">');
    expect(html).toContain('<details class="ls-model-comparison ls-model-evidence">');
    expect(html).toContain("Change quality");
    expect(html).not.toContain('class="ls-model-auto-card"');
  });

  it("keeps an active download visible outside its collapsible profiles", () => {
    const html = renderModelSettings({ action: {
      action: "installing", familyId: "qwen3-asr-0-6b", tier: "high",
      progress: { phase: "downloading", completedBytes: 10, totalBytes: 100 },
    } });
    expect(html.indexOf('class="ls-model-operation-progress"')).toBeLessThan(html.indexOf('class="ls-model-profiles"'));
    expect(html.match(/role="progressbar"/g)).toHaveLength(1);
    expect(html).toContain('class="ls-model-profiles" open=""');
  });

  it("labels comparison controls, benchmark limits, and conversion provenance", () => {
    const html = renderModelSettings();
    expect(html).toContain("Sort models");
    expect(html).toContain("Memory / download profile");
    expect(html).toContain("Estimated memory: high → low");
    expect(html).toContain("Reference WER: low → high");
    expect(html).toContain("Reference speed: fast → slow");
    expect(html).toContain("not Mac speed or quantized accuracy predictions");
    expect(html).toContain("Copy source URLs");
    expect(html).toContain("MLX Community conversion");
    expect(html).toContain("NVIDIA H200");
    expect(html).toContain("1.70%");
    expect(html).not.toContain('href="https://');
  });

  it("derives model experience from catalog capabilities rather than family-name guesses", () => {
    const base = catalog().families[0]!;
    const parakeet = {
      ...base,
      familyId: "parakeet-unified-en" as unknown as typeof base.familyId,
      displayName: "Parakeet Unified EN",
      capabilities: {
        ...afterStopCapabilities,
        modes: ["after-stop", "live"] as ("after-stop" | "live")[],
        partialResults: true,
        supportedLanguages: ["en"],
      },
    };
    const live = {
      ...base,
      familyId: "moonshine-streaming-medium" as unknown as typeof base.familyId,
      displayName: "Moonshine Streaming Medium",
      capabilities: {
        ...afterStopCapabilities,
        modes: ["live"] as ("after-stop" | "live")[],
        partialResults: true,
        supportedLanguages: ["en"],
      },
    };

    expect(modelFamilyPresentation(parakeet)).toMatchObject({
      experience: "after-stop",
      experiences: ["after-stop", "live"],
      recommendation: "recommended",
      latencyLabel: "Fast final dictation",
    });
    expect(modelFamilyPresentation(live)).toMatchObject({
      experience: "live",
      recommendation: "live",
      latencyLabel: "Live recognition",
    });
  });

  it("only exposes profiles that the selected family actually supplies", () => {
    const family = {
      ...catalog().families[0]!,
      profiles: catalog().families[0]!.profiles.filter((profile) => profile.tier !== "low"),
    };

    expect(supportedModeChoices(family).map((choice) => choice.id)).toEqual(["auto", "high", "medium"]);
  });

  it("uses a mode-first picker and keeps unavailable live recognition visibly unavailable", () => {
    const html = renderModelSettings();

    expect(html).toContain("When should text appear?");
    expect(html).toContain('<strong>After I stop</strong>');
    expect(html).toContain('<strong>Live</strong>');
    expect(html).toContain("No streaming model in this catalog");
    expect(html).toContain("will not silently substitute another model");
    expect(html).toContain("Both run locally and insert the finished text after you stop.");
    expect(html).not.toContain("may show a private preview");
    expect(html).toContain("Model library and technical details");
    expect(html).toContain("Technical details");
  });

  it("makes Parakeet easy to find for final dictation without treating it as the Live preview choice", () => {
    const parakeet = {
      ...catalog().families[0]!,
      familyId: "parakeet-unified-en-0-6b" as unknown as ModelCatalog["families"][number]["familyId"],
      displayName: "Parakeet Unified",
      capabilities: { ...afterStopCapabilities, modes: ["after-stop", "live"] as ("after-stop" | "live")[], partialResults: true },
      recommendedDefault: true,
    };

    expect(modelFamilyPresentation(parakeet)).toMatchObject({
      experience: "after-stop",
      summary: "Fast final dictation after you stop speaking. Recommended for a polished local result.",
      latencyLabel: "Fast final dictation",
    });
  });

  it("names staged, applying, and confirmed runtime states instead of implying a selection is already live", () => {
    const pending = renderModelSettings({
      pendingSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "medium" },
      mode: "medium",
    });
    expect(pending).toContain("Pending model change");
    expect(pending).toContain("Nothing changes until you apply this pending selection.");
    expect(pending).toContain("After applying");

    const applying = renderModelSettings({ applying: true });
    expect(applying).toContain("Applying model change");
    expect(applying).toContain("Applying model…");

    const ready = renderModelSettings({ currentModelLoaded: true });
    expect(ready).toContain("Applied and ready");
    expect(ready).toContain("This selection is loaded and ready for dictation.");
    expect(ready).toContain("Saved selection");
    expect(ready).toContain("Resident runtime");
    expect(ready).toContain("Qwen3-ASR 0.6B medium");

    const mismatchedResident = renderModelSettings({
      currentModelLoaded: false,
      residentRuntimeLabel: "Different resident runtime",
    });
    expect(mismatchedResident).toContain("Selected model is not loaded");
    expect(mismatchedResident).toContain("Saved selection");
    expect(mismatchedResident).toContain("Different resident runtime");
  });

  it("takes every model control out of service during an explicit refresh", () => {
    const html = renderModelSettings({ refreshing: true });

    expect(html).toContain("Refreshing…");
    expect(html).toContain("Refreshing model status…");
    expect(applyButtonTag(html)).toContain('disabled=""');
    expect(storageButtonTags(html).every((tag) => tag.includes('disabled=""'))).toBe(true);
  });

  it("renders byte progress only when runtime reports real byte counts", () => {
    expect(modelActionProgressPresentation({
      action: "installing",
      familyId: "qwen3-asr-0-6b",
      tier: "high",
      progress: { phase: "downloading", completedBytes: 500_000_000, totalBytes: 2_000_000_000 },
    }, 2_000_000_000)).toMatchObject({
      label: "Downloading 0.50 GB of 2.00 GB (25%)",
      percent: 25,
    });
    expect(modelActionProgressPresentation({
      action: "installing",
      familyId: "qwen3-asr-0-6b",
      tier: "high",
      progress: { phase: "preparing" },
    }, 2_000_000_000)).toMatchObject({
      label: "Preparing secure download…",
      percent: null,
    });
    expect(modelActionProgressPresentation({
      action: "installing",
      familyId: "qwen3-asr-0-6b",
      tier: "high",
      progress: { phase: "verifying", completedBytes: 500_000_000, totalBytes: 2_000_000_000 },
    }, 2_000_000_000)).toMatchObject({
      label: "Verifying 0.50 GB of 2.00 GB (25%)",
      percent: 25,
    });

    const html = renderModelSettings({
      action: {
        action: "installing",
        familyId: "qwen3-asr-0-6b",
        tier: "high",
        progress: { phase: "downloading", completedBytes: 500_000_000, totalBytes: 2_000_000_000 },
      },
    });
    expect(html).toContain("Downloading 0.50 GB of 2.00 GB (25%)");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="25"');
  });

  it("allows an exact verified persisted selection to load when its runtime is cold", () => {
    const eligibility = modelApplyEligibility({
      currentSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "auto" },
      currentModelLoaded: false,
      pendingSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "auto" },
      resolvedTier: "high",
      catalog: catalog(),
      catalogError: null,
      runtimeTierStatuses: [{ familyId: "qwen3-asr-0-6b", tier: "high", artifactId: "qwen3-asr-0-6b-high", verificationStatus: "verified" }],
      hardware: { platform: "darwin", displayName: "Apple M-series GPU", totalMemoryBytes: 48 * GIBIBYTE, availableMemoryBytes: 31 * GIBIBYTE, memoryBasis: "measured" },
      memoryRequirement: { requiredFreeMemoryBytes: null, reservedHeadroomBytes: 2 * GIBIBYTE },
      action: null,
      applying: false,
      refreshing: false,
    });

    expect(eligibility).toMatchObject({ enabled: true, targetTier: "high", targetVerification: "verified" });
    expect(renderModelSettings({ currentModelLoaded: false })).toContain("Load current model");
  });

  /*
   * `expect(html).toContain("disabled")` used to stand in for this. It could
   * not fail: the button always emits `aria-disabled`, so the substring is
   * present whether the control is enabled or not. Read the button itself, and
   * pin the enabled case alongside it so the assertion has a way to fail.
   */
  it("keeps exact warm Apply idempotent", () => {
    const warm = renderModelSettings({ currentModelLoaded: true });
    expect(warm).toContain("Current model is loaded and ready.");
    expect(applyButtonTag(warm)).toContain('disabled=""');
    expect(applyButtonTag(warm)).toContain('aria-disabled="true"');

    const changed = renderModelSettings({
      pendingSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "medium" },
      mode: "medium",
    });
    expect(applyButtonTag(changed)).not.toContain('disabled=""');
    expect(applyButtonTag(changed)).toContain('aria-disabled="false"');
  });

  /*
   * Every other control goes inert during an Apply; the model library's
   * Download/Repair/Remove buttons did not, so they advertised themselves as
   * available while an unload/load ran. Main serialises model operations, so
   * the click was never unsafe — it just silently queued.
   */
  it("takes the model library storage buttons out of service during an Apply", () => {
    const idle = renderModelSettings({ applying: false });
    const applying = renderModelSettings({ applying: true });

    expect(storageButtonTags(idle).length).toBeGreaterThan(0);
    expect(storageButtonTags(idle).some((tag) => tag.includes('disabled=""'))).toBe(false);
    expect(storageButtonTags(applying).length).toBe(storageButtonTags(idle).length);
    expect(storageButtonTags(applying).every((tag) => tag.includes('disabled=""'))).toBe(true);
  });

  /*
   * Main keeps diagnostics observational and reports the unmodified free-memory
   * reading, but the caption used to label that number "normalized for the warm
   * model" — a different, larger figure that only exists inside apply
   * eligibility. The readout and the Apply message then quoted two numbers the
   * user could not reconcile.
   */
  it("does not describe the raw memory reading as normalized for the warm model", () => {
    const html = renderModelSettings({ currentModelLoaded: true });
    expect(html).not.toContain("normalized for the warm model");
    expect(html).not.toContain("Selection budget");
    expect(html).toContain("Available now (a warm model is resident)");
  });

  it("enables one combined Apply only for a changed, verified, memory-eligible target", () => {
    const modelCatalog = catalog();
    const eligibility = modelApplyEligibility({
      currentSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "auto" },
      currentModelLoaded: true,
      pendingSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "medium" },
      resolvedTier: "high",
      catalog: modelCatalog,
      catalogError: null,
      runtimeTierStatuses: [{
        familyId: "qwen3-asr-0-6b",
        tier: "medium",
        artifactId: "qwen3-asr-0-6b-medium",
        verificationStatus: "verified",
      }],
      hardware: {
        platform: "darwin",
        displayName: "Apple M-series GPU",
        totalMemoryBytes: 48 * GIBIBYTE,
        availableMemoryBytes: 31 * GIBIBYTE,
        memoryBasis: "measured",
      },
      memoryRequirement: { requiredFreeMemoryBytes: null, reservedHeadroomBytes: 2 * GIBIBYTE },
      action: null,
      applying: false,
      refreshing: false,
    });

    expect(eligibility).toMatchObject({
      enabled: true,
      targetTier: "medium",
      targetVerification: "verified",
    });
  });

  it("accounts conservatively for memory released by the warm model before Apply", () => {
    const eligibility = modelApplyEligibility({
      currentSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "high" },
      currentModelLoaded: true,
      pendingSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "medium" },
      resolvedTier: "high",
      catalog: catalog(),
      catalogError: null,
      runtimeTierStatuses: [{
        familyId: "qwen3-asr-0-6b",
        tier: "medium",
        artifactId: "qwen3-asr-0-6b-medium",
        verificationStatus: "verified",
      }],
      hardware: {
        platform: "darwin",
        displayName: "Apple M-series GPU",
        totalMemoryBytes: 8 * GIBIBYTE,
        availableMemoryBytes: 2 * GIBIBYTE,
        memoryBasis: "measured",
      },
      memoryRequirement: {
        requiredFreeMemoryBytes: 5 * GIBIBYTE,
        reservedHeadroomBytes: 2 * GIBIBYTE,
      },
      action: null,
      applying: false,
      refreshing: false,
    });

    // The raw reading is only 2 GiB, but unloading the current High profile
    // conservatively releases its 3 GiB minimum before Medium loads.
    expect(eligibility).toMatchObject({
      enabled: true,
      targetTier: "medium",
      targetVerification: "verified",
    });
  });

  it("disables Apply when the exact selected artifact is missing", () => {
    const html = renderModelSettings({
      currentSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "auto" },
      pendingSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "high" },
      mode: "high",
    });

    expect(html).toContain("Download the selected model profile before applying.");
    expect(html).toContain('class="ls-primary-button ls-model-apply-button" disabled="" aria-disabled="true"');
  });

  it("derives current and pending labels from the catalog", () => {
    const html = renderModelSettings({
      catalog: catalog({ secondaryInLibrary: true }),
      currentSelection: { familyId: "qwen3-asr-0-6b", asrMode: "after-stop", performanceMode: "auto" },
      pendingSelection: { familyId: "qwen3-asr-1-7b", asrMode: "after-stop", performanceMode: "low" },
      mode: "low",
    });

    expect(html).toContain("Saved selection</dt><dd>Qwen3-ASR 0.6B · After I stop · Auto");
    expect(html).toContain("After applying</dt><dd>Qwen3-ASR 1.7B · After I stop · Low");
    expect(html).toContain("Selected to apply");
  });

  it("keeps family selection separate from the four accessible performance choices", () => {
    const html = renderModelSettings();

    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="high"');
    expect(html).toContain('value="medium"');
    expect(html).toContain('value="low"');
    expect(html).toContain("Changes wait for Apply model.");
    expect(html).toContain("Saved selection");
    expect(html).toContain("Resident runtime");
    expect(html).toContain("Apply model");
    expect(html).toContain("Qwen3-ASR 0.6B");
    expect(html).toContain("Recommended");
    expect(html).toContain("Qwen3-ASR 1.7B");
    expect(html).toContain("Add to library");
    expect(html).toContain("Add to library to manage");
    expect(html).not.toContain("Built-in family");
  });

  it("renders a curated Qwen family from catalog data with platform-specific profiles", () => {
    const modelCatalog = catalog();
    modelCatalog.families.splice(1, 1, {
      familyId: "qwen3-asr-1-7b",
      displayName: "Qwen3-ASR 1.7B",
      capabilities: afterStopCapabilities,
      recommendedDefault: false,
      active: false,
      inLibrary: false,
      artifacts: (["bf16", "8bit", "4bit"] as const).map((precision, index) => ({
        artifactId: `qwen3-asr-1-7b-mlx-${precision}`,
        displayName: `Qwen3-ASR 1.7B · MLX ${precision}`,
        backend: "MLX Audio",
        modelId: `curated/qwen3-asr-1-7b-${precision}`,
        storageDirectory: `qwen3-asr-1-7b-${precision}`,
        revision: `${index + 4}`.repeat(40),
        license: "Apache-2.0",
        expectedDownloadBytes: [4_080_710_353, 2_467_859_030, 1_607_633_106][index]!,
      })),
      profiles: (["high", "medium", "low"] as const).map((tier, index) => ({
        profileId: `qwen3-asr-1-7b-${tier}`,
        tier,
        artifactId: `qwen3-asr-1-7b-mlx-${(["bf16", "8bit", "4bit"] as const)[index]}`,
        engine: "mlx-audio",
        precision: (["bf16", "8-bit", "4-bit"] as const)[index]!,
        expectedMemoryMinBytes: [4.2, 2.6, 1.8][index]! * GIBIBYTE,
        expectedMemoryMaxBytes: [5.4, 3.6, 2.8][index]! * GIBIBYTE,
        memoryBasis: "estimated",
      })),
    });

    const html = renderModelSettings({ catalog: modelCatalog });

    expect(html).toContain("Qwen3-ASR 1.7B");
    expect(html).toContain("<dt>Runtime</dt><dd>MLX Audio</dd>");
    expect(html).toContain("BF16");
    expect(html).toContain("8-bit");
    expect(html).toContain("4-bit");
    expect(html).toContain("Apache-2.0");
    expect(html).toContain("Add to library");
    expect(html).toContain("Add to library to manage");
  });

  it("permits the default family data install when memory telemetry is unavailable", () => {
    const macCatalog = catalog({ sharedPrimaryArtifact: true });
    const html = renderModelSettings({
      catalog: macCatalog,
      hardware: {
        platform: "darwin",
        displayName: "Apple Silicon",
        totalMemoryBytes: null,
        availableMemoryBytes: null,
        memoryBasis: "unavailable",
      },
      memoryRequirement: null,
      runtimeTierStatuses: [{
        familyId: "qwen3-asr-0-6b",
        tier: "high",
        artifactId: "synthetic-qwen3-asr-0-6b-shared",
        qualityNote: "Curated macOS artifact.",
        verificationStatus: "missing",
      }],
    });

    expect(html).toContain("Qwen3-ASR 0.6B");
    expect(html).toContain("<dt>Runtime</dt><dd>MLX Audio</dd>");
    expect(html).toContain("Run eligibility is unknown");
    expect(html).toContain("Availability · unavailable");
    expect(html).not.toContain("Available now · unavailable");
    expect(html).toContain('<button type="button" class="ls-small-button" aria-label="Download High profile for qwen3-asr-0-6b">Download</button>');
    expect(html).toContain("Shared artifact · managed from High");
    expect(html).not.toContain("Checking the local model catalog");
  });

  it("does not claim an explicit profile is running when unified memory is insufficient", () => {
    const macCatalog = catalog({ sharedPrimaryArtifact: true });
    const html = renderModelSettings({
      mode: "high",
      resolvedTier: "high",
      fitsMemoryBudget: false,
      resolutionReason: "High was selected explicitly.",
      hardware: {
        platform: "darwin",
        displayName: "Apple Silicon",
        totalMemoryBytes: 8 * GIBIBYTE,
        availableMemoryBytes: 4 * GIBIBYTE,
        memoryBasis: "measured",
      },
      memoryRequirement: {
        requiredFreeMemoryBytes: 10 * GIBIBYTE,
        reservedHeadroomBytes: 2 * GIBIBYTE,
      },
      catalog: macCatalog,
      runtimeTierStatuses: (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "qwen3-asr-0-6b" as const,
        tier,
        artifactId: "synthetic-qwen3-asr-0-6b-shared",
        qualityNote: "Curated macOS profile.",
        verificationStatus: "verified" as const,
      })),
    });

    expect(html).toContain("<strong>High</strong> selected");
    expect(html).not.toContain("Using <strong>High</strong>");
    expect(html).toContain(
      "<strong>High</strong> cannot run with the unified memory currently available. Dictation stays blocked until enough unified memory is available or you choose a lower profile.",
    );
    expect(html).toContain(
      "requires <strong>10.0 GiB</strong> free unified memory, including 2.00 GiB reserved headroom",
    );
  });

  it("derives shared controls from artifact identity", () => {
    const shared = renderModelSettings({
      catalog: catalog({ sharedPrimaryArtifact: true }),
      runtimeTierStatuses: [{
        familyId: "qwen3-asr-0-6b",
        tier: "high",
        artifactId: "synthetic-qwen3-asr-0-6b-shared",
        qualityNote: "One artifact.",
        verificationStatus: "missing",
      }],
    });
    const distinct = renderModelSettings({
      catalog: catalog({ sharedPrimaryArtifact: false }),
      runtimeTierStatuses: (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "qwen3-asr-0-6b" as const,
        tier,
        artifactId: `qwen3-asr-0-6b-${tier}`,
        qualityNote: "Distinct artifact.",
        verificationStatus: "missing" as const,
      })),
    });

    expect(shared.match(/aria-label="Download [^"]*profile for qwen3-asr-0-6b"/g)).toHaveLength(1);
    expect(shared.match(/Shared artifact/g)).toHaveLength(2);
    expect(distinct.match(/aria-label="Download [^"]*profile for qwen3-asr-0-6b"/g)).toHaveLength(3);
    expect(distinct).not.toContain("Shared artifact");
  });

  it("renders one truthful install, repair, or remove control for a shared artifact", () => {
    const sharedCatalog = catalog({ sharedPrimaryArtifact: true });
    const runtimeStatuses = (verificationStatus: "missing" | "invalid" | "verified") => (
      (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "qwen3-asr-0-6b" as const,
        tier,
        artifactId: "synthetic-qwen3-asr-0-6b-shared",
        qualityNote: "Curated macOS profile.",
        verificationStatus,
      }))
    );
    const missing = renderModelSettings({
      catalog: sharedCatalog,
      runtimeTierStatuses: runtimeStatuses("missing"),
      action: { action: "installing", familyId: "qwen3-asr-0-6b", tier: "high" },
    });
    const invalid = renderModelSettings({
      catalog: sharedCatalog,
      runtimeTierStatuses: runtimeStatuses("invalid"),
      action: { action: "repairing", familyId: "qwen3-asr-0-6b", tier: "high" },
    });
    const verified = renderModelSettings({
      catalog: sharedCatalog,
      runtimeTierStatuses: runtimeStatuses("verified"),
      action: { action: "removing", familyId: "qwen3-asr-0-6b", tier: "high" },
    });

    expect(missing.match(/Downloading…/g)).toHaveLength(1);
    expect(invalid.match(/Repairing…/g)).toHaveLength(1);
    expect(verified.match(/Removing…/g)).toHaveLength(1);
    expect(missing.match(/Shared artifact · managed from High/g)).toHaveLength(2);
    expect(invalid.match(/Shared artifact · managed from High/g)).toHaveLength(2);
    expect(verified.match(/Shared artifact · managed from High/g)).toHaveLength(2);
    expect(missing.match(/aria-label="Download [^"]*profile for qwen3-asr-0-6b"/g)).toHaveLength(1);
    expect(invalid.match(/aria-label="Repair [^"]*profile for qwen3-asr-0-6b"/g)).toHaveLength(1);
    expect(verified.match(/aria-label="Remove [^"]*profile for qwen3-asr-0-6b"/g)).toHaveLength(1);
  });

  it("keeps a confirmed artifact operation visible across an early status refresh", () => {
    const sharedCatalog = catalog({ sharedPrimaryArtifact: true });
    const renderAction = (
      verificationStatus: "missing" | "invalid" | "verified",
      action: NonNullable<ModelPerformanceSettingsProps["action"]>["action"],
    ) => renderModelSettings({
      catalog: sharedCatalog,
      runtimeTierStatuses: (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "qwen3-asr-0-6b" as const,
        tier,
        artifactId: "synthetic-qwen3-asr-0-6b-shared",
        qualityNote: "Curated macOS profile.",
        verificationStatus,
      })),
      action: { action, familyId: "qwen3-asr-0-6b", tier: "high" },
    });

    const installAfterVerifiedRefresh = renderAction("verified", "installing");
    const repairAfterVerifiedRefresh = renderAction("verified", "repairing");
    const removeAfterMissingRefresh = renderAction("missing", "removing");

    expect(installAfterVerifiedRefresh).toContain(">Downloading…</button>");
    expect(installAfterVerifiedRefresh).not.toContain(">Remove</button>");
    expect(repairAfterVerifiedRefresh).toContain(">Repairing…</button>");
    expect(repairAfterVerifiedRefresh).not.toContain(">Remove</button>");
    expect(removeAfterMissingRefresh).toContain(">Removing…</button>");
    expect(removeAfterMissingRefresh).not.toContain(">Download</button>");
  });

  it("shows an added secondary family as selectable and keeps artifact management separate", () => {
    const modelCatalog = catalog({ secondaryInLibrary: true });
    // Inject an unreviewed license to preserve the explicit warning regression;
    // shipped Qwen artifacts carry Apache-2.0.
    modelCatalog.families[1]!.artifacts[0]!.license = "Undeclared";
    const html = renderModelSettings({ catalog: modelCatalog });

    expect(html).toContain("In your library");
    expect(html).toContain("Select");
    expect(html).toContain("Profiles &amp; downloads");
    expect(html).toContain("Undeclared — review required");
    expect(html).toContain("Check / download");
  });

  it("derives family backends and inactive management eligibility from the catalog", () => {
    const runtimeCatalog = catalog({ activeFamilyId: "qwen3-asr-1-7b" });
    const inactiveDefaultFamily = runtimeCatalog.families[0]!;
    runtimeCatalog.families[0] = {
      ...inactiveDefaultFamily,
      artifacts: inactiveDefaultFamily.artifacts.map((artifact) => ({
        ...artifact,
        backend: "Catalog-provided macOS backend",
      })),
    };
    const html = renderModelSettings({
      catalog: runtimeCatalog,
      runtimeTierStatuses: [],
    });
    const inactiveDefault = html.slice(
      html.indexOf("<h3>Qwen3-ASR 0.6B</h3>"),
      html.indexOf("<h3>Qwen3-ASR 1.7B</h3>"),
    );

    expect(inactiveDefault).toContain("<dt>Runtime</dt><dd>Catalog-provided macOS backend</dd>");
    expect(inactiveDefault).toContain("Select and apply this family to load its runtime quality details.");
    expect(inactiveDefault).toContain("Check / download");
    expect(inactiveDefault).not.toContain("Built-in family");
    expect(html).toContain("Runtime quality details are unavailable until model diagnostics refresh.");
  });

  it("shows verified artifact state for an inactive library family, including shared profiles", () => {
    const html = renderModelSettings({
      catalog: catalog({ secondaryInLibrary: true, sharedSecondaryArtifact: true }),
      runtimeTierStatuses: (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "qwen3-asr-1-7b" as const,
        tier,
        artifactId: "synthetic-qwen3-asr-1-7b-shared",
        verificationStatus: "verified" as const,
      })),
    });
    const inactiveFamily = html.slice(html.indexOf("<h3>Qwen3-ASR 1.7B</h3>"));

    expect(inactiveFamily.match(/Verified/g)).toHaveLength(3);
    expect(inactiveFamily).not.toContain("Status unavailable");
    expect(inactiveFamily).toContain("Remove High profile for qwen3-asr-1-7b");
  });

  it("lists unmanaged and interrupted model storage without offering a destructive action", () => {
    const modelCatalog = catalog();
    const html = renderModelSettings({
      catalog: {
        ...modelCatalog,
        unmanagedEntries: [
          {
            name: "qwen3-asr-old",
            kind: "directory",
            reason: "unmanaged",
            sizeBytes: 2_300_000_000,
          },
          {
            name: ".install-partial",
            kind: "directory",
            reason: "interrupted-install",
            sizeBytes: null,
          },
        ],
      },
    });
    const unmanaged = html.slice(html.indexOf("Other model storage found"));

    expect(unmanaged).toContain("qwen3-asr-old");
    expect(unmanaged).toContain("Unmanaged model data · directory · 2.30 GB");
    expect(unmanaged).toContain(".install-partial");
    expect(unmanaged).toContain("Interrupted model installation · directory · Size unavailable");
    expect(unmanaged).toContain("will not be deleted automatically");
    expect(unmanaged).not.toContain("<button");
  });

  it("renders friendly precision, memory evidence, and exact free-memory headroom", () => {
    const html = renderModelSettings();

    expect(html).toContain("BF16");
    expect(html).toContain("8-bit");
    expect(html).toContain("4-bit");
    expect(html).toContain("3.00 GiB–4.00 GiB estimated");
    expect(html).toContain("requires <strong>9.00 GiB</strong> free unified memory, including 2.00 GiB reserved headroom");
  });

  it("reports catalog failure directly instead of an endless checking state", () => {
    const html = renderModelSettings({
      catalog: null,
      catalogError: "IPC unavailable",
      hardware: null,
      memoryRequirement: null,
      runtimeTierStatuses: [],
    });

    expect(html).toContain("Could not load the curated model catalog: IPC unavailable");
    expect(html).toContain("Run eligibility is unknown");
    expect(html).not.toContain("Loading curated model catalog");
  });
});
