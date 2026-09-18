import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRuntimeModelCatalog,
  resolveModelPerformance,
  runtimeModelTier,
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
  const catalog = loadRuntimeModelCatalog(
    manifestDirectory,
    "darwin",
    "arm64",
    "qwen3-asr-1-7b",
  );

  it("uses both total and free memory with conservative headroom", () => {
    const high = resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 12 * GIBIBYTE },
    });
    expect(high).toMatchObject({
      effectiveTier: "high",
      reason: "auto-highest-fit",
      fitsMemoryBudget: true,
    });
    // Diagnostics must show the actual decision threshold: 5.4 GiB maximum
    // working memory plus 20% of total memory (3.2 GiB) headroom.
    expect(high.reservedHeadroomBytes).toBe(Math.ceil(3.2 * GIBIBYTE));
    expect(high.requiredMemoryBytes).toBe(
      runtimeModelTier(catalog, "high").acceleratorMemory.maximumBytes + Math.ceil(3.2 * GIBIBYTE),
    );

    expect(resolveModelPerformance({
      preference: "auto",
      catalog,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 6.5 * GIBIBYTE },
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
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 6.5 * GIBIBYTE },
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
    expect(result.tier.engine).toBe("mlx-audio");
  });

  it.each([
    ["high", 4, 2],
    ["medium", 4, 2],
    ["low", 4, 2],
  ] as const)(
    "keeps explicit %s exact even when the current memory budget blocks it",
    (preference, totalGiB, freeGiB) => {
      expect(resolveModelPerformance({
        preference,
        catalog,
        memory: {
          totalBytes: totalGiB * GIBIBYTE,
          freeBytes: freeGiB * GIBIBYTE,
        },
      })).toMatchObject({
        preference,
        effectiveTier: preference,
        reason: "explicit",
        fitsMemoryBudget: false,
      });
    },
  );

  it.each([
    [8, 7, "medium", true],
    [16, 12, "high", true],
    [48, 16, "high", true],
    [128, 26, "low", false],
  ] as const)(
    "derives Apple Auto from %d GiB total and %d GiB currently free",
    (totalGiB, freeGiB, effectiveTier, fitsMemoryBudget) => {
      expect(resolveModelPerformance({
        preference: "auto",
        catalog,
        memory: {
          totalBytes: totalGiB * GIBIBYTE,
          freeBytes: freeGiB * GIBIBYTE,
        },
      })).toMatchObject({
        effectiveTier,
        fitsMemoryBudget,
      });
    },
  );

  it("applies the same telemetry policy to every curated model family", () => {
    for (const familyId of [
      "parakeet-unified-en-0-6b",
      "whisper-large-v3",
      "qwen3-asr-0-6b",
      "qwen3-asr-1-7b",
      "canary-qwen-2-5b",
    ] as const) {
      const family = loadRuntimeModelCatalog(
        manifestDirectory,
        "darwin",
        "arm64",
        familyId,
      );
      expect(resolveModelPerformance({
        preference: "auto",
        catalog: family,
        memory: { totalBytes: 48 * GIBIBYTE, freeBytes: 20 * GIBIBYTE },
      })).toMatchObject({
        effectiveTier: "high",
        fitsMemoryBudget: true,
        tier: { familyId },
      });
    }
  });

  it("rejects a cross-engine tier instead of falling back across engines", () => {
    const crossedCatalog = {
      ...catalog,
      tiers: {
        ...catalog.tiers,
        low: {
          ...runtimeModelTier(catalog, "low"),
          engine: "fluid-audio" as const,
        },
      },
    };
    expect(() => resolveModelPerformance({
      preference: "low",
      catalog: crossedCatalog,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 12 * GIBIBYTE },
    })).toThrow(/crosses a platform, engine, or tier routing boundary/);
  });

  it("binds the complete catalog engine and tier precisions to the runtime platform", () => {
    const crossedEngine = {
      ...catalog,
      engine: "fluid-audio" as const,
      tiers: Object.fromEntries(Object.entries(catalog.tiers).flatMap(([tier, spec]) => (
        spec ? [[tier, { ...spec, engine: "fluid-audio" as const }]] : []
      ))) as typeof catalog.tiers,
    };
    expect(() => resolveModelPerformance({
      preference: "medium",
      catalog: crossedEngine,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 12 * GIBIBYTE },
    })).toThrow(/crosses a platform, engine, or tier routing boundary/);

    const crossedPrecision = {
      ...catalog,
      tiers: {
        ...catalog.tiers,
        high: {
          ...runtimeModelTier(catalog, "high"),
          precision: "8-bit" as const,
        },
      },
    };
    expect(() => resolveModelPerformance({
      preference: "high",
      catalog: crossedPrecision,
      memory: { totalBytes: 16 * GIBIBYTE, freeBytes: 12 * GIBIBYTE },
    })).toThrow(/crosses a platform, engine, or tier routing boundary/);
  });

  it("keeps Parakeet High unquantized and Medium INT8 without inventing Low", () => {
    const parakeet = loadRuntimeModelCatalog(
      manifestDirectory,
      "darwin",
      "arm64",
      "parakeet-unified-en-0-6b",
    );
    expect(resolveModelPerformance({
      preference: "high",
      catalog: parakeet,
      memory: { totalBytes: 48 * GIBIBYTE, freeBytes: 20 * GIBIBYTE },
    })).toMatchObject({
      effectiveTier: "high",
      tier: { engine: "fluid-audio", precision: "coreml-fp16" },
    });
    expect(resolveModelPerformance({
      preference: "medium",
      catalog: parakeet,
      memory: { totalBytes: 48 * GIBIBYTE, freeBytes: 20 * GIBIBYTE },
    })).toMatchObject({
      effectiveTier: "medium",
      tier: { engine: "fluid-audio", precision: "coreml-int8" },
    });
    expect(() => resolveModelPerformance({
      preference: "low",
      catalog: parakeet,
      memory: { totalBytes: 48 * GIBIBYTE, freeBytes: 20 * GIBIBYTE },
    })).toThrow(/no low performance profile/u);
  });
});
