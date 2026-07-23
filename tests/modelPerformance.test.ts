import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRuntimeModelCatalog,
  resolveModelPerformance,
} from "../src/main/modelSpec";
import {
  acceleratorMemorySnapshotSchema,
  MODEL_PERFORMANCE_PREFERENCES,
  MODEL_PERFORMANCE_TIERS,
  modelPerformancePreferenceSchema,
  modelPerformanceTierSchema,
} from "../src/shared/modelPerformance";

const GIBIBYTE = 1024 ** 3;
const manifestDirectory = path.resolve("resources/model-manifest");

describe("model performance vocabulary", () => {
  it("accepts exactly four preferences and three concrete tiers", () => {
    expect(MODEL_PERFORMANCE_PREFERENCES).toEqual(["auto", "high", "medium", "low"]);
    expect(MODEL_PERFORMANCE_TIERS).toEqual(["high", "medium", "low"]);
    for (const preference of MODEL_PERFORMANCE_PREFERENCES) {
      expect(modelPerformancePreferenceSchema.parse(preference)).toBe(preference);
    }
    for (const tier of MODEL_PERFORMANCE_TIERS) {
      expect(modelPerformanceTierSchema.parse(tier)).toBe(tier);
    }
    expect(() => modelPerformancePreferenceSchema.parse("balanced")).toThrow();
    expect(() => modelPerformanceTierSchema.parse("auto")).toThrow();
  });

  it("requires total and free accelerator memory as one internally consistent snapshot", () => {
    expect(acceleratorMemorySnapshotSchema.parse({
      totalBytes: 16 * GIBIBYTE,
      freeBytes: 10 * GIBIBYTE,
    })).toEqual({
      totalBytes: 16 * GIBIBYTE,
      freeBytes: 10 * GIBIBYTE,
    });
    expect(acceleratorMemorySnapshotSchema.parse({
      totalBytes: null,
      freeBytes: null,
    })).toEqual({
      totalBytes: null,
      freeBytes: null,
    });
    expect(() => acceleratorMemorySnapshotSchema.parse({
      totalBytes: 8 * GIBIBYTE,
      freeBytes: 9 * GIBIBYTE,
    })).toThrow(/cannot exceed total/);
    expect(() => acceleratorMemorySnapshotSchema.parse({
      totalBytes: 8 * GIBIBYTE,
      freeBytes: null,
    })).toThrow(/both be available or both be unavailable/);
  });
});

describe("automatic model performance resolution", () => {
  const catalog = loadRuntimeModelCatalog(manifestDirectory, "darwin", "arm64");

  it("uses both total and free memory with conservative headroom", () => {
    expect(resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 12 * GIBIBYTE },
    })).toMatchObject({
      effectiveTier: "high",
      reason: "auto-highest-fit",
      fitsMemoryBudget: true,
    });

    expect(resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 6 * GIBIBYTE },
    })).toMatchObject({
      effectiveTier: "low",
      reason: "auto-highest-fit",
      fitsMemoryBudget: true,
    });

    expect(resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: 6 * GIBIBYTE, freeBytes: 6 * GIBIBYTE },
    })).toMatchObject({
      effectiveTier: "medium",
      reason: "auto-highest-fit",
      fitsMemoryBudget: true,
    });
  });

  it("reports insufficient memory when memory is unknown or no tier fits", () => {
    expect(resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: null, freeBytes: null },
    })).toMatchObject({
      effectiveTier: "low",
      reason: "auto-insufficient-memory",
      fitsMemoryBudget: false,
    });
    expect(resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: 4 * GIBIBYTE, freeBytes: 2 * GIBIBYTE },
    })).toMatchObject({
      effectiveTier: "low",
      reason: "auto-insufficient-memory",
      fitsMemoryBudget: false,
    });
  });

  it("uses hysteresis for upgrades but promptly downgrades an unsafe previous tier", () => {
    expect(resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 9 * GIBIBYTE },
      previousTier: "medium",
    })).toMatchObject({
      effectiveTier: "medium",
      reason: "auto-hysteresis-hold",
    });

    expect(resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 10 * GIBIBYTE },
      previousTier: "medium",
    })).toMatchObject({
      effectiveTier: "high",
      reason: "auto-highest-fit",
    });

    expect(resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 6 * GIBIBYTE },
      previousTier: "high",
    })).toMatchObject({
      effectiveTier: "low",
      reason: "auto-highest-fit",
    });
  });

  it("pins the selected concrete tier for an active dictation", () => {
    expect(resolveModelPerformance({
      preference: "high",
      catalog,
      memory: { totalBytes: 4 * GIBIBYTE, freeBytes: 2 * GIBIBYTE },
      activeDictationTier: "medium",
    })).toMatchObject({
      preference: "high",
      effectiveTier: "medium",
      reason: "dictation-active",
    });
  });

  it("honors explicit tiers without substituting another tier or engine", () => {
    const result = resolveModelPerformance({
      preference: "high",
      catalog,
      memory: { totalBytes: 4 * GIBIBYTE, freeBytes: 2 * GIBIBYTE },
    });
    expect(result).toMatchObject({
      preference: "high",
      effectiveTier: "high",
      reason: "explicit",
      fitsMemoryBudget: false,
    });
    expect(result.tier.engine).toBe("mlx-whisper");
  });

  it("rejects a cross-engine tier instead of falling back across engines", () => {
    const crossedCatalog = {
      ...catalog,
      tiers: {
        ...catalog.tiers,
        low: {
          ...catalog.tiers.low,
          engine: "faster-whisper" as const,
        },
      },
    };
    expect(() => resolveModelPerformance({
      preference: "low",
      catalog: crossedCatalog,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 12 * GIBIBYTE },
    })).toThrow(/crosses a platform, engine, or tier routing boundary/);
  });

  it("resolves Windows compute tiers inside the faster-whisper catalog only", () => {
    const windowsCatalog = loadRuntimeModelCatalog(manifestDirectory, "win32", "x64");
    const high = resolveModelPerformance({
      preference: "auto",
      catalog: windowsCatalog,
      memory: { totalBytes: 8 * GIBIBYTE, freeBytes: 7.5 * GIBIBYTE },
    });
    expect(high).toMatchObject({
      effectiveTier: "high",
      tier: {
        engine: "faster-whisper",
        precision: "float16",
      },
    });

    const medium = resolveModelPerformance({
      preference: "auto",
      catalog: windowsCatalog,
      memory: { totalBytes: 8 * GIBIBYTE, freeBytes: 6 * GIBIBYTE },
    });
    expect(medium).toMatchObject({
      effectiveTier: "medium",
      tier: {
        engine: "faster-whisper",
        precision: "int8_float16",
      },
    });
    expect(medium.tier.manifest).toEqual(high.tier.manifest);
  });
});
