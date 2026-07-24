import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "../src/shared/contracts";
import {
  ModelPerformanceSettings,
  type ModelPerformanceSettingsProps,
} from "../src/renderer/settings/screens/ModelPerformanceSettings";

const GIBIBYTE = 1_073_741_824;

function catalog({
  platform = "darwin-arm64",
  sharedV3Artifact = false,
  v2InLibrary = false,
}: {
  platform?: ModelCatalog["platform"];
  sharedV3Artifact?: boolean;
  v2InLibrary?: boolean;
} = {}): ModelCatalog {
  const v3ArtifactId = sharedV3Artifact ? "whisper-large-v3-shared" : undefined;
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
    activeModelFamilyId: "whisper-large-v3",
    modelLibraryFamilyIds: v2InLibrary ? ["whisper-large-v3", "whisper-large-v2"] : ["whisper-large-v3"],
    families: [
      {
        familyId: "whisper-large-v3",
        displayName: "Whisper large-v3",
        active: true,
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
        active: false,
        inLibrary: v2InLibrary,
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
  };
}

function renderModelSettings(overrides: Partial<ModelPerformanceSettingsProps> = {}) {
  const props: ModelPerformanceSettingsProps = {
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
    onModeChange: vi.fn(),
    onInstall: vi.fn(),
    onRepair: vi.fn(),
    onRemove: vi.fn(),
    onAddFamily: vi.fn(),
    onActivateFamily: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<ModelPerformanceSettings {...props} />);
}

describe("ModelPerformanceSettings", () => {
  it("keeps family selection separate from the four accessible performance choices", () => {
    const html = renderModelSettings();

    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="high"');
    expect(html).toContain('value="medium"');
    expect(html).toContain('value="low"');
    expect(html).toContain("Family selection changes the speech model");
    expect(html).toContain("Whisper large-v3");
    expect(html).toContain("Built-in default");
    expect(html).toContain("Whisper large-v2");
    expect(html).toContain("Add to library");
  });

  it("shows the default Windows family and safe model action when memory telemetry is unavailable", () => {
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
    expect(html).toContain("faster-whisper/CTranslate2 CUDA");
    expect(html).toContain("Run eligibility is unknown");
    expect(html).toContain('aria-label="Download High profile for whisper-large-v3"');
    expect(html).toContain("Shared artifact · managed from High");
    expect(html).not.toContain("Checking the local model catalog");
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

  it("shows an added v2 family as ready to activate and does not offer inactive artifact actions", () => {
    const html = renderModelSettings({ catalog: catalog({ v2InLibrary: true }) });

    expect(html).toContain("Added to library");
    expect(html).toContain("Activate");
    expect(html).toContain("Added locally and ready to activate");
    expect(html).toContain("Undeclared — review required");
    expect(html).toContain("Activate to manage");
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
