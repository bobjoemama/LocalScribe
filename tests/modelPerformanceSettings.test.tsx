import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "../src/shared/contracts";
import {
  modelApplyEligibility,
  ModelPerformanceSettings,
  type ModelPerformanceSettingsProps,
} from "../src/renderer/settings/screens/ModelPerformanceSettings";

const GIBIBYTE = 1_073_741_824;

function catalog({
  platform = "darwin-arm64",
  sharedV3Artifact = false,
  v2InLibrary = false,
  activeFamilyId = "whisper-large-v3",
}: {
  platform?: ModelCatalog["platform"];
  sharedV3Artifact?: boolean;
  v2InLibrary?: boolean;
  activeFamilyId?: ModelCatalog["activeModelFamilyId"];
} = {}): ModelCatalog {
  const v3ArtifactId = sharedV3Artifact ? "whisper-large-v3-shared" : undefined;
  const v2IsInLibrary = v2InLibrary || activeFamilyId === "whisper-large-v2";
  const backend = platform === "darwin-arm64" ? "MLX Whisper" : "faster-whisper/CTranslate2";
  const v3Artifacts = sharedV3Artifact
    ? [{
      artifactId: v3ArtifactId!,
      displayName: "Whisper large-v3 curated artifact",
      backend,
      modelId: "curated/whisper-large-v3",
      storageDirectory: "whisper-large-v3",
      revision: "a".repeat(40),
      license: "MIT",
      expectedDownloadBytes: 3_000_000_000,
    }]
    : ["high", "medium", "low"].map((tier, index) => ({
      artifactId: `whisper-large-v3-${tier}`,
      displayName: `Whisper large-v3 ${tier}`,
      backend,
      modelId: `curated/whisper-large-v3-${tier}`,
      storageDirectory: `whisper-large-v3-${tier}`,
      revision: `${index + 1}`.repeat(40),
      license: "MIT",
      expectedDownloadBytes: (3 - index) * 1_000_000_000,
    }));
  const profiles = ["high", "medium", "low"] as const;
  return {
    platform,
    activeModelFamilyId: activeFamilyId,
    modelLibraryFamilyIds: v2IsInLibrary ? ["whisper-large-v3", "whisper-large-v2"] : ["whisper-large-v3"],
    families: [
      {
        familyId: "whisper-large-v3",
        displayName: "Whisper large-v3",
        active: activeFamilyId === "whisper-large-v3",
        inLibrary: true,
        artifacts: v3Artifacts,
        profiles: profiles.map((tier, index) => ({
          profileId: `v3-${tier}`,
          tier,
          artifactId: v3ArtifactId ?? `whisper-large-v3-${tier}`,
          engine: platform === "darwin-arm64" ? "mlx-whisper" : "faster-whisper",
          precision: tier === "high" ? "float16" : tier === "medium" ? "int8_float16" : "int8",
          expectedMemoryMinBytes: (3 - index) * GIBIBYTE,
          expectedMemoryMaxBytes: (4 - index) * GIBIBYTE,
          memoryBasis: "estimated",
        })),
      },
      {
        familyId: "whisper-large-v2",
        displayName: "Whisper large-v2",
        active: activeFamilyId === "whisper-large-v2",
        inLibrary: v2IsInLibrary,
        artifacts: [{
          artifactId: "whisper-large-v2-mlx-fp16",
          displayName: "Whisper large-v2 · MLX float16",
          backend,
          modelId: "curated/whisper-large-v2",
          storageDirectory: "whisper-large-v2",
          revision: "b".repeat(40),
          license: "Undeclared",
          expectedDownloadBytes: 3_000_000_000,
        }],
        profiles: profiles.map((tier, index) => ({
          profileId: `v2-${tier}`,
          tier,
          artifactId: "whisper-large-v2-mlx-fp16",
          engine: platform === "darwin-arm64" ? "mlx-whisper" : "faster-whisper",
          precision: tier === "high" ? "float16" : tier === "medium" ? "8-bit" : "4-bit",
          expectedMemoryMinBytes: (3 - index) * GIBIBYTE,
          expectedMemoryMaxBytes: (4 - index) * GIBIBYTE,
          memoryBasis: "estimated",
        })),
      },
    ],
    verifications: [
      ...v3Artifacts.map((artifact) => ({
        familyId: "whisper-large-v3" as const,
        artifactId: artifact.artifactId,
        present: false,
        verified: false,
        verificationStatus: "missing" as const,
        sizeBytes: 0,
        expectedBytes: artifact.expectedDownloadBytes,
        verifiedFiles: 0,
        expectedFiles: 1,
      })),
      {
        familyId: "whisper-large-v2",
        artifactId: "whisper-large-v2-mlx-fp16",
        present: false,
        verified: false,
        verificationStatus: "missing",
        sizeBytes: 0,
        expectedBytes: 3_000_000_000,
        verifiedFiles: 0,
        expectedFiles: 1,
      },
    ],
    unmanagedEntries: [],
  };
}

function renderModelSettings(overrides: Partial<ModelPerformanceSettingsProps> = {}) {
  const props: ModelPerformanceSettingsProps = {
    currentSelection: {
      familyId: "whisper-large-v3",
      performanceMode: "auto",
    },
    currentModelLoaded: true,
    pendingSelection: {
      familyId: "whisper-large-v3",
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
        familyId: "whisper-large-v3",
        tier: "high",
        artifactId: "whisper-large-v3-high",
        qualityNote: "Highest local transcription quality.",
        verificationStatus: "missing",
      },
      {
        familyId: "whisper-large-v3",
        tier: "medium",
        artifactId: "whisper-large-v3-medium",
        qualityNote: "Balanced quality and memory use.",
        verificationStatus: "verified",
      },
      {
        familyId: "whisper-large-v3",
        tier: "low",
        artifactId: "whisper-large-v3-low",
        qualityNote: "Lowest memory use.",
        verificationStatus: "invalid",
      },
    ],
    action: null,
    feedback: null,
    applying: false,
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

describe("ModelPerformanceSettings", () => {
  it("allows an exact verified persisted selection to load when its runtime is cold", () => {
    const eligibility = modelApplyEligibility({
      currentSelection: { familyId: "whisper-large-v3", performanceMode: "auto" },
      currentModelLoaded: false,
      pendingSelection: { familyId: "whisper-large-v3", performanceMode: "auto" },
      resolvedTier: "high",
      catalog: catalog(),
      catalogError: null,
      runtimeTierStatuses: [{ familyId: "whisper-large-v3", tier: "high", artifactId: "whisper-large-v3-high", verificationStatus: "verified" }],
      hardware: { platform: "darwin", displayName: "Apple M-series GPU", totalMemoryBytes: 48 * GIBIBYTE, availableMemoryBytes: 31 * GIBIBYTE, memoryBasis: "measured" },
      memoryRequirement: { requiredFreeMemoryBytes: null, reservedHeadroomBytes: 2 * GIBIBYTE },
      action: null,
      applying: false,
    });

    expect(eligibility).toMatchObject({ enabled: true, targetTier: "high", targetVerification: "verified" });
    expect(renderModelSettings({ currentModelLoaded: false })).toContain("Load current model");
  });

  it("keeps exact warm Apply idempotent", () => {
    const html = renderModelSettings({ currentModelLoaded: true });
    expect(html).toContain("Current model is loaded and ready.");
    expect(html).toContain("disabled");
  });

  it("enables one combined Apply only for a changed, verified, memory-eligible target", () => {
    const modelCatalog = catalog();
    const eligibility = modelApplyEligibility({
      currentSelection: { familyId: "whisper-large-v3", performanceMode: "auto" },
      currentModelLoaded: true,
      pendingSelection: { familyId: "whisper-large-v3", performanceMode: "medium" },
      resolvedTier: "high",
      catalog: modelCatalog,
      catalogError: null,
      runtimeTierStatuses: [{
        familyId: "whisper-large-v3",
        tier: "medium",
        artifactId: "whisper-large-v3-medium",
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
    });

    expect(eligibility).toMatchObject({
      enabled: true,
      targetTier: "medium",
      targetVerification: "verified",
    });
  });

  it("accounts conservatively for memory released by the warm model before Apply", () => {
    const eligibility = modelApplyEligibility({
      currentSelection: { familyId: "whisper-large-v3", performanceMode: "high" },
      currentModelLoaded: true,
      pendingSelection: { familyId: "whisper-large-v3", performanceMode: "medium" },
      resolvedTier: "high",
      catalog: catalog(),
      catalogError: null,
      runtimeTierStatuses: [{
        familyId: "whisper-large-v3",
        tier: "medium",
        artifactId: "whisper-large-v3-medium",
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
      currentSelection: { familyId: "whisper-large-v3", performanceMode: "auto" },
      pendingSelection: { familyId: "whisper-large-v3", performanceMode: "high" },
      mode: "high",
    });

    expect(html).toContain("Download the selected model profile before applying.");
    expect(html).toContain('class="ls-primary-button ls-model-apply-button" disabled="" aria-disabled="true"');
  });

  it("derives current and pending labels from the catalog", () => {
    const html = renderModelSettings({
      catalog: catalog({ v2InLibrary: true }),
      currentSelection: { familyId: "whisper-large-v3", performanceMode: "auto" },
      pendingSelection: { familyId: "whisper-large-v2", performanceMode: "low" },
      mode: "low",
    });

    expect(html).toContain("Currently using</dt><dd>Whisper large-v3 · Auto");
    expect(html).toContain("After applying</dt><dd>Whisper large-v2 · Low");
    expect(html).toContain("Selected to apply");
  });

  it("keeps family selection separate from the four accessible performance choices", () => {
    const html = renderModelSettings();

    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="high"');
    expect(html).toContain('value="medium"');
    expect(html).toContain('value="low"');
    expect(html).toContain("Changing these controls only stages a choice");
    expect(html).toContain("Currently using");
    expect(html).toContain("After applying");
    expect(html).toContain("Apply model");
    expect(html).toContain("Whisper large-v3");
    expect(html).toContain("Built-in default");
    expect(html).toContain("Whisper large-v2");
    expect(html).toContain("Add to library");
    expect(html).toContain("Add to library to manage");
    expect(html).not.toContain("Built-in family");
  });

  it("renders a curated Qwen family from catalog data with platform-specific profiles", () => {
    const modelCatalog = catalog();
    modelCatalog.families.splice(1, 0, {
      familyId: "qwen3-asr-1-7b",
      displayName: "Qwen3-ASR 1.7B",
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
    expect(html).toContain("Catalog backend: MLX Audio");
    expect(html).toContain("BF16");
    expect(html).toContain("8-bit");
    expect(html).toContain("4-bit");
    expect(html).toContain("Apache-2.0");
    expect(html).toContain("Add to library");
    expect(html).toContain("Add to library to manage");
  });

  it("permits the default Windows family data install when memory telemetry is unavailable", () => {
    const windowsCatalog = catalog({ platform: "win32-x64-cuda", sharedV3Artifact: true });
    const html = renderModelSettings({
      catalog: windowsCatalog,
      hardware: {
        platform: "win32",
        displayName: "NVIDIA GPU",
        totalMemoryBytes: null,
        availableMemoryBytes: null,
        memoryBasis: "unavailable",
      },
      memoryRequirement: null,
      runtimeTierStatuses: [{
        familyId: "whisper-large-v3",
        tier: "high",
        artifactId: "whisper-large-v3-shared",
        qualityNote: "Curated Windows artifact.",
        verificationStatus: "missing",
      }],
    });

    expect(html).toContain("Whisper large-v3");
    expect(html).toContain("Catalog backend: faster-whisper/CTranslate2");
    expect(html).toContain("Run eligibility is unknown");
    expect(html).toContain("Availability · unavailable");
    expect(html).not.toContain("Available now · unavailable");
    expect(html).toContain('<button type="button" class="ls-small-button" aria-label="Download High profile for whisper-large-v3">Download</button>');
    expect(html).toContain("Shared artifact · managed from High");
    expect(html).not.toContain("Checking the local model catalog");
  });

  it("does not claim an explicit Windows profile is running when reported VRAM is insufficient", () => {
    const windowsCatalog = catalog({ platform: "win32-x64-cuda", sharedV3Artifact: true });
    const html = renderModelSettings({
      mode: "high",
      resolvedTier: "high",
      fitsMemoryBudget: false,
      resolutionReason: "High was selected explicitly.",
      hardware: {
        platform: "win32",
        displayName: "NVIDIA GeForce RTX 4060 · CUDA",
        totalMemoryBytes: 8 * GIBIBYTE,
        availableMemoryBytes: 4 * GIBIBYTE,
        memoryBasis: "measured",
      },
      memoryRequirement: {
        requiredFreeMemoryBytes: 10 * GIBIBYTE,
        reservedHeadroomBytes: 2 * GIBIBYTE,
      },
      catalog: windowsCatalog,
      runtimeTierStatuses: (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "whisper-large-v3" as const,
        tier,
        artifactId: "whisper-large-v3-shared",
        qualityNote: "Curated Windows profile.",
        verificationStatus: "verified" as const,
      })),
    });

    expect(html).toContain("<strong>High</strong> selected");
    expect(html).not.toContain("Using <strong>High</strong>");
    expect(html).toContain(
      "<strong>High</strong> cannot run with the NVIDIA VRAM currently available. Dictation stays blocked until enough NVIDIA VRAM is available or you choose a lower profile.",
    );
    expect(html).toContain(
      "requires <strong>10.0 GiB</strong> free NVIDIA VRAM, including 2.00 GiB reserved headroom",
    );
  });

  it("derives shared controls from artifact identity rather than the platform", () => {
    const shared = renderModelSettings({
      catalog: catalog({ platform: "darwin-arm64", sharedV3Artifact: true }),
      runtimeTierStatuses: [{
        familyId: "whisper-large-v3",
        tier: "high",
        artifactId: "whisper-large-v3-shared",
        qualityNote: "One artifact.",
        verificationStatus: "missing",
      }],
    });
    const distinct = renderModelSettings({
      catalog: catalog({ platform: "win32-x64-cuda", sharedV3Artifact: false }),
      runtimeTierStatuses: (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "whisper-large-v3" as const,
        tier,
        artifactId: `whisper-large-v3-${tier}`,
        qualityNote: "Distinct artifact.",
        verificationStatus: "missing" as const,
      })),
    });

    expect(shared.match(/aria-label="Download [^"]*profile for whisper-large-v3"/g)).toHaveLength(1);
    expect(shared.match(/Shared artifact/g)).toHaveLength(2);
    expect(distinct.match(/aria-label="Download [^"]*profile for whisper-large-v3"/g)).toHaveLength(3);
    expect(distinct).not.toContain("Shared artifact");
  });

  it("renders one truthful install, repair, or remove control for a shared Windows artifact", () => {
    const windowsCatalog = catalog({ platform: "win32-x64-cuda", sharedV3Artifact: true });
    const runtimeStatuses = (verificationStatus: "missing" | "invalid" | "verified") => (
      (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "whisper-large-v3" as const,
        tier,
        artifactId: "whisper-large-v3-shared",
        qualityNote: "Curated Windows profile.",
        verificationStatus,
      }))
    );
    const missing = renderModelSettings({
      catalog: windowsCatalog,
      runtimeTierStatuses: runtimeStatuses("missing"),
      action: { action: "installing", familyId: "whisper-large-v3", tier: "high" },
    });
    const invalid = renderModelSettings({
      catalog: windowsCatalog,
      runtimeTierStatuses: runtimeStatuses("invalid"),
      action: { action: "repairing", familyId: "whisper-large-v3", tier: "high" },
    });
    const verified = renderModelSettings({
      catalog: windowsCatalog,
      runtimeTierStatuses: runtimeStatuses("verified"),
      action: { action: "removing", familyId: "whisper-large-v3", tier: "high" },
    });

    expect(missing.match(/Downloading…/g)).toHaveLength(1);
    expect(invalid.match(/Repairing…/g)).toHaveLength(1);
    expect(verified.match(/Removing…/g)).toHaveLength(1);
    expect(missing.match(/Shared artifact · managed from High/g)).toHaveLength(2);
    expect(invalid.match(/Shared artifact · managed from High/g)).toHaveLength(2);
    expect(verified.match(/Shared artifact · managed from High/g)).toHaveLength(2);
    expect(missing.match(/aria-label="Download [^"]*profile for whisper-large-v3"/g)).toHaveLength(1);
    expect(invalid.match(/aria-label="Repair [^"]*profile for whisper-large-v3"/g)).toHaveLength(1);
    expect(verified.match(/aria-label="Remove [^"]*profile for whisper-large-v3"/g)).toHaveLength(1);
  });

  it("keeps the confirmed Windows artifact operation visible across an early status refresh", () => {
    const windowsCatalog = catalog({ platform: "win32-x64-cuda", sharedV3Artifact: true });
    const renderAction = (
      verificationStatus: "missing" | "invalid" | "verified",
      action: NonNullable<ModelPerformanceSettingsProps["action"]>["action"],
    ) => renderModelSettings({
      catalog: windowsCatalog,
      runtimeTierStatuses: (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "whisper-large-v3" as const,
        tier,
        artifactId: "whisper-large-v3-shared",
        qualityNote: "Curated Windows profile.",
        verificationStatus,
      })),
      action: { action, familyId: "whisper-large-v3", tier: "high" },
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

  it("shows an added v2 family as selectable and keeps artifact management separate", () => {
    const html = renderModelSettings({ catalog: catalog({ v2InLibrary: true }) });

    expect(html).toContain("Added to library");
    expect(html).toContain("Select");
    expect(html).toContain("Added locally. Select it");
    expect(html).toContain("Undeclared — review required");
    expect(html).toContain("Check / download");
  });

  it("derives family backends and inactive management eligibility from the catalog", () => {
    const runtimeCatalog = catalog({ activeFamilyId: "whisper-large-v2" });
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
      html.indexOf("<h3>Whisper large-v3</h3>"),
      html.indexOf("<h3>Whisper large-v2</h3>"),
    );

    expect(inactiveDefault).toContain("Catalog backend: Catalog-provided macOS backend");
    expect(inactiveDefault).toContain("Select and apply this family to load its runtime quality details.");
    expect(inactiveDefault).toContain("Check / download");
    expect(inactiveDefault).not.toContain("Built-in family");
    expect(html).toContain("Runtime quality details are unavailable until model diagnostics refresh.");
  });

  it("shows verified artifact state for an inactive library family, including shared profiles", () => {
    const html = renderModelSettings({
      catalog: catalog({ v2InLibrary: true }),
      runtimeTierStatuses: (["high", "medium", "low"] as const).map((tier) => ({
        familyId: "whisper-large-v2" as const,
        tier,
        artifactId: "whisper-large-v2-mlx-fp16",
        verificationStatus: "verified" as const,
      })),
    });
    const inactiveFamily = html.slice(html.indexOf("<h3>Whisper large-v2</h3>"));

    expect(inactiveFamily.match(/Verified/g)).toHaveLength(3);
    expect(inactiveFamily).not.toContain("Status unavailable");
    expect(inactiveFamily).toContain("Remove High profile for whisper-large-v2");
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

    expect(html).toContain("FP16");
    expect(html).toContain("INT8 weights + FP16 compute");
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
