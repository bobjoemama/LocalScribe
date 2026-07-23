import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ModelPerformanceSettings,
  type ModelPerformanceSettingsProps,
} from "../src/renderer/settings/screens/ModelPerformanceSettings";

const GIBIBYTE = 1_073_741_824;

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
    tiers: [
      {
        tier: "high",
        displayName: "Large speech model",
        backend: "MLX",
        precision: "FP16",
        downloadBytes: 6_000_000_000,
        acceleratorMemory: {
          minimumBytes: 10 * GIBIBYTE,
          maximumBytes: 12 * GIBIBYTE,
          basis: "measured",
        },
        qualityNote: "Highest local transcription quality.",
        verificationStatus: "missing",
      },
      {
        tier: "medium",
        displayName: "Medium speech model",
        backend: "MLX",
        precision: "FP16",
        downloadBytes: 3_000_000_000,
        acceleratorMemory: {
          minimumBytes: 6 * GIBIBYTE,
          maximumBytes: 8 * GIBIBYTE,
          basis: "measured",
        },
        qualityNote: "Balanced quality and memory use.",
        verificationStatus: "verified",
      },
      {
        tier: "low",
        displayName: "Compact speech model",
        backend: "MLX",
        precision: "FP16",
        downloadBytes: 1_000_000_000,
        acceleratorMemory: {
          minimumBytes: 3 * GIBIBYTE,
          maximumBytes: 4 * GIBIBYTE,
          basis: "estimated",
        },
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
    onRefresh: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<ModelPerformanceSettings {...props} />);
}

describe("ModelPerformanceSettings", () => {
  it("renders four accessible radio choices and the resolved Auto tier", () => {
    const html = renderModelSettings();

    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="high"');
    expect(html).toContain('value="medium"');
    expect(html).toContain('value="low"');
    expect(html).toContain("Auto resolves to");
    expect(html).toContain("Currently Medium");
    expect(html).toContain("Recheck memory");
  });

  it("does not present Low as resolved or selected when Auto cannot fit any tier", () => {
    const html = renderModelSettings({
      mode: "auto",
      resolvedTier: "low",
      fitsMemoryBudget: false,
      resolutionReason: "Auto could not verify enough free accelerator memory.",
    });

    expect(html).toContain("Auto resolves to <strong>No tier fits</strong>");
    expect(html).toContain("<small>No tier fits</small>");
    expect(html).not.toContain("Currently Low");
    expect(html).not.toContain("ls-model-tier-row is-selected");
    expect(html).not.toContain("<span>Selected</span>");
  });

  it("renders contract-supplied facts and one truthful action for each state", () => {
    const html = renderModelSettings();

    expect(html).toContain("Large speech model");
    expect(html).toContain("MLX");
    expect(html).toContain("FP16");
    expect(html).toContain("10.0 GiB–12.0 GiB measured");
    expect(html).toContain("Highest local transcription quality.");
    expect(html).toContain("Verified");
    expect(html).toContain("Missing");
    expect(html).toContain("Repair required");
    expect(html).toContain('aria-label="Install High model"');
    expect(html).toContain('aria-label="Remove Medium model"');
    expect(html).toContain('aria-label="Repair Low model"');
    expect(html).not.toMatch(/fallback|whisper\.cpp|qwen/i);
  });

  it("keeps failures readable and announced beside the model controls", () => {
    const html = renderModelSettings({
      feedback: {
        message: "Could not install the High model. Check your connection and available storage, then try again.",
        isError: true,
      },
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not install the High model.");
    expect(html).toContain("available storage");
  });

  it("uses Windows-specific NVIDIA VRAM and faster-whisper copy", () => {
    const html = renderModelSettings({
      hardware: {
        platform: "win32",
        displayName: "NVIDIA RTX GPU",
        totalMemoryBytes: 16 * GIBIBYTE,
        availableMemoryBytes: 12 * GIBIBYTE,
        memoryBasis: "measured",
      },
    });

    expect(html).toContain("NVIDIA VRAM");
    expect(html).toContain("faster-whisper");
    expect(html).toContain("NVIDIA RTX GPU");
    expect(html).toContain("one verified large-v3 download for all three modes");
    expect(html.match(/Shared download/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="Install High model"');
    expect(html).toContain('aria-label="Remove Medium model"');
    expect(html).not.toContain('aria-label="Repair Low model"');
  });
});
