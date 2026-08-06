import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_MODEL_FAMILY_ID,
  MODEL_FAMILY_IDS,
  modelFamilyIdSchema,
  type ModelFamilyId,
} from "../shared/contracts";
import {
  type AcceleratorMemorySnapshot,
  type ModelPerformancePreference,
  type ModelPerformanceTier,
  type ModelResourceEvidenceKind,
} from "../shared/modelPerformance";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const stableIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const huggingFaceRepositoryIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,
  "modelId must be a Hugging Face repository ID, never a URL or local path",
);
const manifestFileSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: sha256Schema,
}).strict();

/**
 * A packaged manifest is the sole authority for an artifact's repository,
 * immutable revision, files, and stable artifact identity. Nothing supplied
 * by a renderer can alter these fields.
 */
export const modelSpecSchema = z.object({
  schemaVersion: z.literal(1),
  familyId: modelFamilyIdSchema,
  artifactId: stableIdSchema,
  platform: z.enum(["darwin-arm64", "win32-x64-cuda"]),
  backend: z.string().min(1).max(120),
  displayName: z.string().min(1).max(200),
  modelId: huggingFaceRepositoryIdSchema,
  storageDirectory: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  // "Undeclared" is intentional when an audited artifact provides no license
  // metadata; do not infer a project-wide license from another model family.
  license: z.string().min(1).max(120),
  files: z.record(
    z.string().regex(/^(?:\.gitattributes|[A-Za-z0-9][A-Za-z0-9._-]*)$/),
    manifestFileSchema,
  ).refine((files) => Object.keys(files).length > 0, "a model manifest must list files"),
}).strict();

export type ModelSpec = z.infer<typeof modelSpecSchema>;
export type ModelVerificationStatus = "missing" | "invalid" | "verified";
export type ModelCatalogPlatform = ModelSpec["platform"];
export type ModelEngine =
  | "mlx-whisper"
  | "mlx-audio"
  | "faster-whisper"
  | "crispasr";
export type ModelPrecision =
  | "fp16"
  | "bf16"
  | "8-bit"
  | "4-bit"
  | "float16"
  | "int8_float16"
  | "int8"
  | "q8_0"
  | "q4_k";

export interface ModelResourceEvidence {
  kind: ModelResourceEvidenceKind;
  source: string;
  auditedAt: string;
}

export interface ModelAcceleratorMemoryMetadata {
  minimumBytes: number;
  maximumBytes: number;
  evidence: ModelResourceEvidence;
}

export interface RuntimeModelTierSpec {
  familyId: ModelFamilyId;
  artifactId: string;
  /** Stable selection profile; it identifies a family/tier compute policy. */
  profileId: string;
  tier: ModelPerformanceTier;
  modelKey: ModelPerformanceTier;
  engine: ModelEngine;
  precision: ModelPrecision;
  expectedDownloadBytes: number;
  downloadEvidence: ModelResourceEvidence;
  acceleratorMemory: ModelAcceleratorMemoryMetadata;
  manifestFilename: string;
  manifest: ModelSpec;
}

/** One curated model family for exactly one packaged runtime platform. */
export interface RuntimeModelCatalog {
  platform: ModelCatalogPlatform;
  familyId: ModelFamilyId;
  displayName: string;
  engine: ModelEngine;
  tiers: Record<ModelPerformanceTier, RuntimeModelTierSpec>;
}

/** Complete curated catalog for a platform, independent of device probing. */
export interface RuntimePlatformModelCatalog {
  platform: ModelCatalogPlatform;
  families: Record<ModelFamilyId, RuntimeModelCatalog>;
}

export interface ResolveModelPerformanceInput {
  preference: ModelPerformancePreference;
  catalog: RuntimeModelCatalog;
  memory: AcceleratorMemorySnapshot;
  previousTier?: ModelPerformanceTier;
  activeDictationTier?: ModelPerformanceTier;
}

export type ModelPerformanceResolutionReason =
  | "explicit"
  | "dictation-active"
  | "auto-highest-fit"
  | "auto-hysteresis-hold"
  | "auto-insufficient-memory";

export interface ModelPerformanceResolution {
  preference: ModelPerformancePreference;
  effectiveTier: ModelPerformanceTier;
  tier: RuntimeModelTierSpec;
  reason: ModelPerformanceResolutionReason;
  fitsMemoryBudget: boolean;
  reservedHeadroomBytes: number | null;
  /** Required free accelerator memory including reserved system headroom. */
  requiredMemoryBytes: number | null;
}

export interface ModelVerification {
  present: boolean;
  verified: boolean;
  verificationStatus: ModelVerificationStatus;
  sizeBytes: number;
  expectedBytes: number;
  verifiedFiles: number;
  expectedFiles: number;
}

export type ModelCatalogVerifications = Record<ModelPerformanceTier, ModelVerification>;
export type ModelRootDirectoryStatus = "missing" | "safe" | "invalid";

export interface RuntimeModelArtifactVerification extends ModelVerification {
  familyId: ModelFamilyId;
  artifactId: string;
}

const GIBIBYTE = 1024 ** 3;
// Deliberate safety policy for every mode: model working-memory estimates do
// not include the OS, Electron, other apps, or transient allocator peaks.
// Explicit tiers never fall back, but they still fail closed below this
// reserve. Auto additionally applies upgrade hysteresis.
const MINIMUM_ACCELERATOR_HEADROOM_BYTES = 2 * GIBIBYTE;
const ACCELERATOR_HEADROOM_FRACTION = 0.2;
const AUTO_UPGRADE_HYSTERESIS_BYTES = GIBIBYTE;

interface CatalogTierDefinition {
  manifestFilename: string;
  engine: ModelEngine;
  precision: ModelPrecision;
  acceleratorMemory: ModelAcceleratorMemoryMetadata;
}

interface FamilyCatalogDefinition {
  familyId: ModelFamilyId;
  displayName: string;
  engine: ModelEngine;
  tiers: Record<ModelPerformanceTier, CatalogTierDefinition>;
}

type PlatformCatalogDefinition = {
  [Platform in ModelCatalogPlatform]: {
    families: Record<ModelFamilyId, FamilyCatalogDefinition>;
  };
};

const immutableArtifactAudit = (
  modelId: string,
  revision: string,
): ModelResourceEvidence => ({
  kind: "measured",
  source: `https://huggingface.co/${modelId}/tree/${revision}`,
  auditedAt: "2026-07-23",
});

const estimatedMemory = (source: string, minimumGiB: number, maximumGiB: number) => ({
  minimumBytes: Math.ceil(minimumGiB * GIBIBYTE),
  maximumBytes: Math.ceil(maximumGiB * GIBIBYTE),
  evidence: {
    kind: "estimated" as const,
    source,
    auditedAt: "2026-07-23",
  },
});

const mlxTier = (
  familyId: ModelFamilyId,
  input: {
    manifestFilename: string;
    precision: "fp16" | "8-bit" | "4-bit";
    memory: readonly [number, number];
  },
): CatalogTierDefinition => ({
  manifestFilename: input.manifestFilename,
  engine: "mlx-whisper",
  precision: input.precision,
  acceleratorMemory: estimatedMemory(
    `MLX Whisper ${familyId} ${input.precision} artifact size plus conservative inference overhead; physical benchmark pending`,
    input.memory[0],
    input.memory[1],
  ),
});

const windowsTier = (
  familyId: ModelFamilyId,
  precision: "float16" | "int8_float16" | "int8",
  input: {
    manifestFilename: string;
    memory: readonly [number, number];
  },
): CatalogTierDefinition => ({
  manifestFilename: input.manifestFilename,
  engine: "faster-whisper",
  precision,
  acceleratorMemory: estimatedMemory(
    `CTranslate2 ${familyId} ${precision} weights plus conservative CUDA inference overhead; physical benchmark pending`,
    input.memory[0],
    input.memory[1],
  ),
});

const mlxAudioTier = (
  familyLabel: string,
  input: {
    manifestFilename: string;
    precision: "bf16" | "8-bit" | "4-bit";
    memory: readonly [number, number];
  },
): CatalogTierDefinition => ({
  manifestFilename: input.manifestFilename,
  engine: "mlx-audio",
  precision: input.precision,
  acceleratorMemory: estimatedMemory(
    `MLX Audio ${familyLabel} ${input.precision} artifact size plus conservative inference overhead; physical benchmark pending`,
    input.memory[0],
    input.memory[1],
  ),
});

const crispAsrTier = (
  familyLabel: string,
  input: {
    manifestFilename: string;
    precision: "float16" | "q8_0" | "q4_k";
    memory: readonly [number, number];
  },
): CatalogTierDefinition => ({
  manifestFilename: input.manifestFilename,
  engine: "crispasr",
  precision: input.precision,
  acceleratorMemory: estimatedMemory(
    `CrispASR ${familyLabel} ${input.precision} GGUF plus conservative CUDA inference overhead; physical Windows benchmark pending`,
    input.memory[0],
    input.memory[1],
  ),
});

const v3Mac: FamilyCatalogDefinition = {
  familyId: "whisper-large-v3",
  displayName: "Whisper large-v3",
  engine: "mlx-whisper",
  tiers: {
    high: mlxTier("whisper-large-v3", {
      manifestFilename: "whisper-large-v3-mlx.json",
      precision: "fp16",
      memory: [4, 5.5],
    }),
    medium: mlxTier("whisper-large-v3", {
      manifestFilename: "whisper-large-v3-mlx-8bit.json",
      precision: "8-bit",
      memory: [2.5, 3.5],
    }),
    low: mlxTier("whisper-large-v3", {
      manifestFilename: "whisper-large-v3-mlx-4bit.json",
      precision: "4-bit",
      memory: [1.8, 2.7],
    }),
  },
};

const v2Mac: FamilyCatalogDefinition = {
  familyId: "whisper-large-v2",
  displayName: "Whisper large-v2",
  engine: "mlx-whisper",
  tiers: {
    high: mlxTier("whisper-large-v2", {
      manifestFilename: "whisper-large-v2-mlx.json",
      precision: "fp16",
      memory: [4, 5.5],
    }),
    medium: mlxTier("whisper-large-v2", {
      manifestFilename: "whisper-large-v2-mlx-8bit.json",
      precision: "8-bit",
      memory: [2.5, 3.5],
    }),
    low: mlxTier("whisper-large-v2", {
      manifestFilename: "whisper-large-v2-mlx-4bit.json",
      precision: "4-bit",
      memory: [1.8, 2.7],
    }),
  },
};

const qwenMac: FamilyCatalogDefinition = {
  familyId: "qwen3-asr-1-7b",
  displayName: "Qwen3-ASR 1.7B",
  engine: "mlx-audio",
  tiers: {
    high: mlxAudioTier("Qwen3-ASR 1.7B", {
      manifestFilename: "qwen3-asr-1-7b-mlx-bf16.json",
      precision: "bf16",
      memory: [4.2, 5.4],
    }),
    medium: mlxAudioTier("Qwen3-ASR 1.7B", {
      manifestFilename: "qwen3-asr-1-7b-mlx-8bit.json",
      precision: "8-bit",
      memory: [2.6, 3.6],
    }),
    low: mlxAudioTier("Qwen3-ASR 1.7B", {
      manifestFilename: "qwen3-asr-1-7b-mlx-4bit.json",
      precision: "4-bit",
      memory: [1.8, 2.8],
    }),
  },
};

const qwen06Mac: FamilyCatalogDefinition = {
  familyId: "qwen3-asr-0-6b",
  displayName: "Qwen3-ASR 0.6B",
  engine: "mlx-audio",
  tiers: {
    high: mlxAudioTier("Qwen3-ASR 0.6B", {
      manifestFilename: "qwen3-asr-0-6b-mlx-bf16.json",
      precision: "bf16",
      memory: [2, 3],
    }),
    medium: mlxAudioTier("Qwen3-ASR 0.6B", {
      manifestFilename: "qwen3-asr-0-6b-mlx-8bit.json",
      precision: "8-bit",
      memory: [1.4, 2.3],
    }),
    low: mlxAudioTier("Qwen3-ASR 0.6B", {
      manifestFilename: "qwen3-asr-0-6b-mlx-4bit.json",
      precision: "4-bit",
      memory: [1.1, 2],
    }),
  },
};

const v3WindowsArtifact = {
  manifestFilename: "faster-whisper-large-v3.json",
} as const;

const v2WindowsArtifact = {
  manifestFilename: "faster-whisper-large-v2.json",
} as const;

const windowsFamily = (
  familyId: ModelFamilyId,
  displayName: string,
  artifact: typeof v3WindowsArtifact | typeof v2WindowsArtifact,
): FamilyCatalogDefinition => ({
  familyId,
  displayName,
  engine: "faster-whisper",
  tiers: {
    high: windowsTier(familyId, "float16", { ...artifact, memory: [4.5, 5.5] }),
    medium: windowsTier(familyId, "int8_float16", { ...artifact, memory: [2.9, 3.5] }),
    low: windowsTier(familyId, "int8", { ...artifact, memory: [2.6, 3.3] }),
  },
});

const qwenWindows: FamilyCatalogDefinition = {
  familyId: "qwen3-asr-1-7b",
  displayName: "Qwen3-ASR 1.7B",
  engine: "crispasr",
  tiers: {
    high: crispAsrTier("Qwen3-ASR 1.7B", {
      manifestFilename: "qwen3-asr-1-7b-crisp-f16.json",
      precision: "float16",
      memory: [4.8, 5.8],
    }),
    medium: crispAsrTier("Qwen3-ASR 1.7B", {
      manifestFilename: "qwen3-asr-1-7b-crisp-q8-0.json",
      precision: "q8_0",
      memory: [2.6, 3.6],
    }),
    low: crispAsrTier("Qwen3-ASR 1.7B", {
      manifestFilename: "qwen3-asr-1-7b-crisp-q4-k.json",
      precision: "q4_k",
      memory: [1.8, 2.8],
    }),
  },
};

const qwen06Windows: FamilyCatalogDefinition = {
  familyId: "qwen3-asr-0-6b",
  displayName: "Qwen3-ASR 0.6B",
  engine: "crispasr",
  tiers: {
    high: crispAsrTier("Qwen3-ASR 0.6B", {
      manifestFilename: "qwen3-asr-0-6b-crisp-f16.json",
      precision: "float16",
      memory: [2.5, 3.5],
    }),
    medium: crispAsrTier("Qwen3-ASR 0.6B", {
      manifestFilename: "qwen3-asr-0-6b-crisp-q8-0.json",
      precision: "q8_0",
      memory: [1.6, 2.6],
    }),
    low: crispAsrTier("Qwen3-ASR 0.6B", {
      manifestFilename: "qwen3-asr-0-6b-crisp-q4-k.json",
      precision: "q4_k",
      memory: [1.2, 2.2],
    }),
  },
};

/** Every shipped family is declared for both supported runtime platforms. */
export const MODEL_CATALOG_DEFINITIONS = {
  "darwin-arm64": {
    families: {
      "whisper-large-v3": v3Mac,
      "qwen3-asr-0-6b": qwen06Mac,
      "qwen3-asr-1-7b": qwenMac,
      "whisper-large-v2": v2Mac,
    },
  },
  "win32-x64-cuda": {
    families: {
      "whisper-large-v3": windowsFamily("whisper-large-v3", "Whisper large-v3", v3WindowsArtifact),
      "qwen3-asr-0-6b": qwen06Windows,
      "qwen3-asr-1-7b": qwenWindows,
      "whisper-large-v2": windowsFamily("whisper-large-v2", "Whisper large-v2", v2WindowsArtifact),
    },
  },
} as const satisfies PlatformCatalogDefinition;

export function manifestPlatformForRuntime(platform: NodeJS.Platform, architecture: string): ModelCatalogPlatform {
  if (platform === "darwin" && architecture === "arm64") return "darwin-arm64";
  if (platform === "win32" && architecture === "x64") return "win32-x64-cuda";
  throw new Error(`LocalScribe has no packaged model manifest for ${platform}/${architecture}`);
}

export function modelManifestPath(
  manifestDirectory: string,
  platform: NodeJS.Platform,
  architecture: string,
  tier: ModelPerformanceTier = "medium",
  familyId: ModelFamilyId = DEFAULT_MODEL_FAMILY_ID,
): string {
  const manifestPlatform = manifestPlatformForRuntime(platform, architecture);
  return path.join(
    manifestDirectory,
    MODEL_CATALOG_DEFINITIONS[manifestPlatform].families[familyId].tiers[tier].manifestFilename,
  );
}

export function loadModelSpec(
  manifestPath: string,
  expectedPlatform: ModelCatalogPlatform,
): ModelSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read packaged model manifest at ${manifestPath}`, { cause: error });
  }
  const manifest = modelSpecSchema.parse(raw);
  if (manifest.platform !== expectedPlatform) {
    throw new Error(
      `Packaged model manifest platform mismatch: expected ${expectedPlatform}, received ${manifest.platform}`,
    );
  }
  return manifest;
}

/** Legacy single-family loader; default remains the shipped v3 family. */
export function loadRuntimeModelSpec(
  manifestDirectory: string,
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch,
  tier: ModelPerformanceTier = "medium",
  familyId: ModelFamilyId = DEFAULT_MODEL_FAMILY_ID,
): ModelSpec {
  return loadRuntimeModelCatalog(manifestDirectory, platform, architecture, familyId).tiers[tier].manifest;
}

/** Legacy active-family catalog loader; callers that need all families use the platform loader below. */
export function loadRuntimeModelCatalog(
  manifestDirectory: string,
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch,
  familyId: ModelFamilyId = DEFAULT_MODEL_FAMILY_ID,
): RuntimeModelCatalog {
  return loadRuntimePlatformModelCatalog(manifestDirectory, platform, architecture).families[familyId];
}

/** Loads every curated family for one platform without touching accelerator diagnostics. */
export function loadRuntimePlatformModelCatalog(
  manifestDirectory: string,
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch,
): RuntimePlatformModelCatalog {
  const catalogPlatform = manifestPlatformForRuntime(platform, architecture);
  const platformDefinition = MODEL_CATALOG_DEFINITIONS[catalogPlatform];
  const families = Object.fromEntries(MODEL_FAMILY_IDS.map((familyId) => {
    const definition = platformDefinition.families[familyId];
    const entries = MODEL_TIER_PRIORITY.map((tier) => {
      const tierDefinition = definition.tiers[tier];
      const manifest = loadModelSpec(
        path.join(manifestDirectory, tierDefinition.manifestFilename),
        catalogPlatform,
      );
      assertManifestMatchesCatalog(manifest, definition, tierDefinition, tier);
      const expectedDownloadBytes = Object.values(manifest.files)
        .reduce((sum, file) => sum + file.bytes, 0);
      return [tier, {
        familyId,
        artifactId: manifest.artifactId,
        profileId: `${familyId}-${tier}`,
        tier,
        modelKey: tier,
        engine: tierDefinition.engine,
        precision: tierDefinition.precision,
        expectedDownloadBytes,
        downloadEvidence: immutableArtifactAudit(manifest.modelId, manifest.revision),
        acceleratorMemory: tierDefinition.acceleratorMemory,
        manifestFilename: tierDefinition.manifestFilename,
        manifest,
      }] as const;
    });
    const catalog: RuntimeModelCatalog = {
      platform: catalogPlatform,
      familyId,
      displayName: definition.displayName,
      engine: definition.engine,
      tiers: Object.fromEntries(entries) as Record<ModelPerformanceTier, RuntimeModelTierSpec>,
    };
    assertCatalogRouting(catalog);
    assertCatalogArtifactIdentity(catalog);
    return [familyId, catalog] as const;
  }));
  const catalog: RuntimePlatformModelCatalog = {
    platform: catalogPlatform,
    families: families as Record<ModelFamilyId, RuntimeModelCatalog>,
  };
  assertPlatformCatalogIsolation(catalog);
  return catalog;
}

export function resolveModelPerformance(
  input: ResolveModelPerformanceInput,
): ModelPerformanceResolution {
  assertCatalogRouting(input.catalog);
  const memory = normalizeMemorySnapshot(input.memory);
  const headroom = memory.totalBytes === null
    ? null
    : Math.max(
        MINIMUM_ACCELERATOR_HEADROOM_BYTES,
        Math.ceil(memory.totalBytes * ACCELERATOR_HEADROOM_FRACTION),
      );

  if (input.activeDictationTier) {
    return buildResolution(input, input.activeDictationTier, "dictation-active", memory, headroom);
  }
  if (input.preference !== "auto") {
    return buildResolution(input, input.preference, "explicit", memory, headroom);
  }

  const baseFit = (tier: ModelPerformanceTier) => tierFitsMemory(
    input.catalog.tiers[tier], memory, headroom, 0,
  );
  const highestBaseFit = MODEL_TIER_PRIORITY.find(baseFit);
  if (!highestBaseFit) {
    return buildResolution(input, "low", "auto-insufficient-memory", memory, headroom);
  }
  if (!input.previousTier || !baseFit(input.previousTier)) {
    return buildResolution(input, highestBaseFit, "auto-highest-fit", memory, headroom);
  }

  const previousIndex = MODEL_TIER_PRIORITY.indexOf(input.previousTier);
  const upgrade = MODEL_TIER_PRIORITY.slice(0, previousIndex).find((tier) => tierFitsMemory(
    input.catalog.tiers[tier], memory, headroom, AUTO_UPGRADE_HYSTERESIS_BYTES,
  ));
  if (upgrade) return buildResolution(input, upgrade, "auto-highest-fit", memory, headroom);

  const highestBaseFitIndex = MODEL_TIER_PRIORITY.indexOf(highestBaseFit);
  if (highestBaseFitIndex > previousIndex) {
    return buildResolution(input, highestBaseFit, "auto-highest-fit", memory, headroom);
  }
  return buildResolution(input, input.previousTier, "auto-hysteresis-hold", memory, headroom);
}

const MODEL_TIER_PRIORITY: readonly ModelPerformanceTier[] = ["high", "medium", "low"];

function assertCatalogRouting(catalog: RuntimeModelCatalog): void {
  const definition = MODEL_CATALOG_DEFINITIONS[catalog.platform].families[catalog.familyId];
  const expectedEngine = definition.engine;
  for (const tierName of MODEL_TIER_PRIORITY) {
    const tier = catalog.tiers[tierName];
    if (
      catalog.engine !== expectedEngine
      || tier.tier !== tierName
      || tier.modelKey !== tierName
      || tier.familyId !== catalog.familyId
      || tier.manifest.familyId !== catalog.familyId
      || tier.artifactId !== tier.manifest.artifactId
      || tier.engine !== catalog.engine
      || tier.precision !== definition.tiers[tierName].precision
      || tier.manifest.platform !== catalog.platform
    ) {
      throw new Error(
        `Model catalog ${catalog.platform}/${catalog.familyId}/${tierName} crosses a platform, engine, or tier routing boundary (including family routing)`,
      );
    }
  }
}

/**
 * Physical sharing is derived from immutable manifest identity, never from a
 * platform-specific assumption. A shared artifact must have both one stable
 * manifest artifactId and exactly the same model/revision/storage/files.
 */
function assertCatalogArtifactIdentity(catalog: RuntimeModelCatalog): void {
  const artifactIdentities = new Map<string, string>();
  const artifactForIdentity = new Map<string, string>();
  for (const tier of Object.values(catalog.tiers)) {
    const identity = manifestArtifactIdentity(tier.manifest);
    const priorIdentity = artifactIdentities.get(tier.artifactId);
    if (priorIdentity && priorIdentity !== identity) {
      throw new Error(
        `Packaged ${catalog.platform} artifact ${tier.artifactId} maps to more than one immutable manifest identity`,
      );
    }
    const priorArtifactId = artifactForIdentity.get(identity);
    if (priorArtifactId && priorArtifactId !== tier.artifactId) {
      throw new Error(
        `Packaged ${catalog.platform} manifest identity is assigned multiple artifact IDs`,
      );
    }
    artifactIdentities.set(tier.artifactId, identity);
    artifactForIdentity.set(identity, tier.artifactId);
  }
}

function manifestArtifactIdentity(manifest: ModelSpec): string {
  return JSON.stringify({
    modelId: manifest.modelId,
    revision: manifest.revision,
    storageDirectory: manifest.storageDirectory,
    files: manifest.files,
  });
}

function assertPlatformCatalogIsolation(catalog: RuntimePlatformModelCatalog): void {
  const storageOwners = new Map<string, ModelFamilyId>();
  for (const familyId of MODEL_FAMILY_IDS) {
    const seenArtifacts = new Set<string>();
    for (const tier of Object.values(catalog.families[familyId].tiers)) {
      if (seenArtifacts.has(tier.artifactId)) continue;
      seenArtifacts.add(tier.artifactId);
      const priorFamily = storageOwners.get(tier.manifest.storageDirectory);
      if (priorFamily && priorFamily !== familyId) {
        throw new Error(
          `Packaged ${catalog.platform} model families ${priorFamily} and ${familyId} share a storage directory`,
        );
      }
      storageOwners.set(tier.manifest.storageDirectory, familyId);
    }
  }
}

function assertManifestMatchesCatalog(
  manifest: ModelSpec,
  family: FamilyCatalogDefinition,
  definition: CatalogTierDefinition,
  tier: ModelPerformanceTier,
): void {
  const expectedBackends: Record<ModelEngine, string> = {
    "mlx-whisper": "MLX Whisper",
    "mlx-audio": "MLX Audio",
    "faster-whisper": "faster-whisper/CTranslate2",
    crispasr: "CrispASR CUDA",
  };
  const expectedBackend = expectedBackends[definition.engine];
  const expected = {
    familyId: family.familyId,
    backend: expectedBackend,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field as keyof typeof expected] !== value) {
      throw new Error(
        `Packaged ${family.familyId}/${tier} model manifest ${field} mismatch: expected ${value}, received ${manifest[field as keyof typeof expected]}`,
      );
    }
  }
}

function normalizeMemorySnapshot(snapshot: AcceleratorMemorySnapshot): AcceleratorMemorySnapshot {
  if (
    snapshot.totalBytes === null
    || snapshot.freeBytes === null
    || !Number.isSafeInteger(snapshot.totalBytes)
    || !Number.isSafeInteger(snapshot.freeBytes)
    || snapshot.totalBytes <= 0
    || snapshot.freeBytes < 0
    || snapshot.freeBytes > snapshot.totalBytes
  ) {
    return { totalBytes: null, freeBytes: null };
  }
  return snapshot;
}

function requiredMemoryBytes(
  tier: RuntimeModelTierSpec,
  headroomBytes: number | null,
): number | null {
  return headroomBytes === null ? null : tier.acceleratorMemory.maximumBytes + headroomBytes;
}

function tierFitsMemory(
  tier: RuntimeModelTierSpec,
  memory: AcceleratorMemorySnapshot,
  headroomBytes: number | null,
  additionalFreeHeadroomBytes: number,
): boolean {
  const required = requiredMemoryBytes(tier, headroomBytes);
  if (memory.totalBytes === null || memory.freeBytes === null || required === null) return false;
  return memory.totalBytes >= required && memory.freeBytes >= required + additionalFreeHeadroomBytes;
}

function buildResolution(
  input: ResolveModelPerformanceInput,
  effectiveTier: ModelPerformanceTier,
  reason: ModelPerformanceResolutionReason,
  memory: AcceleratorMemorySnapshot,
  headroomBytes: number | null,
): ModelPerformanceResolution {
  const tier = input.catalog.tiers[effectiveTier];
  return {
    preference: input.preference,
    effectiveTier,
    tier,
    reason,
    fitsMemoryBudget: tierFitsMemory(tier, memory, headroomBytes, 0),
    reservedHeadroomBytes: headroomBytes,
    requiredMemoryBytes: requiredMemoryBytes(tier, headroomBytes),
  };
}

/**
 * Entries macOS itself deposits in a directory, which must not invalidate an
 * otherwise byte-perfect artifact.
 *
 * The exact-entry-set rule below is deliberately strict, and it was too strict
 * to survive contact with the Finder. Opening the models folder to check disk
 * usage writes a `.DS_Store` into it; copying through a non-HFS volume or a zip
 * leaves AppleDouble `._name` sidecars. Either one made a model whose every
 * pinned file was digest-identical report as *not installed*, and the only
 * offered remedy was re-downloading up to 3.4 GB. That is a serious harm caused
 * by a check that was supposed to prevent one.
 *
 * The exemption is narrow on purpose:
 *
 *  - `.DS_Store` and `.localized` by exact name, nothing else;
 *  - an AppleDouble sidecar only for a filename the manifest actually declares,
 *    so `._weights.npz` is tolerated next to `weights.npz` while a planted
 *    `._payload.bin` is not;
 *  - each must be a regular file. A *directory* or symlink named `.DS_Store`
 *    is not something the Finder produces, and it could hide arbitrary
 *    content, so it is still rejected.
 *
 * Tolerating them is safe because the loaders address model files by manifest
 * name; nothing reads these, and their bytes are never counted or hashed.
 */
export function isInertDirectoryMetadata(name: string, expectedNames: ReadonlySet<string>): boolean {
  if (name === ".DS_Store" || name === ".localized") return true;
  return name.startsWith("._") && expectedNames.has(name.slice(2));
}

/**
 * Every manifest file is present and nothing else is, except inert OS metadata.
 * Throws through to the caller's own catch on an unreadable directory, so an
 * IO failure is never mistaken for a clean negative.
 */
async function entrySetMatchesManifest(
  modelDirectory: string,
  entries: readonly string[],
  expectedNames: ReadonlySet<string>,
): Promise<boolean> {
  const present = new Set<string>();
  for (const entry of entries) {
    if (expectedNames.has(entry)) {
      present.add(entry);
      continue;
    }
    if (!isInertDirectoryMetadata(entry, expectedNames)) return false;
    const metadata = await lstat(path.join(modelDirectory, entry));
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  }
  return present.size === expectedNames.size;
}

/**
 * A verified directory must contain exactly the files in the immutable
 * manifest, ignoring the OS metadata named above. Extra files, directories, or
 * symlinks make it invalid rather than silently trusting a mixed artifact.
 */
export async function verifyModelDirectory(
  modelRoot: string,
  model: ModelSpec,
): Promise<ModelVerification> {
  const modelDirectory = path.join(modelRoot, model.storageDirectory);
  const expectedEntries = Object.entries(model.files);
  const expectedNames = new Set(expectedEntries.map(([filename]) => filename));
  const expectedBytes = expectedEntries.reduce((sum, [, file]) => sum + file.bytes, 0);
  const rootStatus = await inspectModelRootDirectory(modelRoot);
  if (rootStatus !== "safe") {
    return {
      present: rootStatus === "invalid",
      verified: false,
      verificationStatus: rootStatus === "invalid" ? "invalid" : "missing",
      sizeBytes: 0,
      expectedBytes,
      verifiedFiles: 0,
      expectedFiles: expectedEntries.length,
    };
  }
  let present = false;
  let exactEntries = false;
  try {
    const metadata = await lstat(modelDirectory);
    present = true;
    // Do not traverse a symlinked artifact directory. Apart from being an
    // invalid install, following it would hash data outside app-owned storage.
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return {
        present: true,
        verified: false,
        verificationStatus: "invalid",
        sizeBytes: 0,
        expectedBytes,
        verifiedFiles: 0,
        expectedFiles: expectedEntries.length,
      };
    }
    const entries = await readdir(modelDirectory);
    exactEntries = await entrySetMatchesManifest(modelDirectory, entries, expectedNames);
  } catch (error) {
    // Only a genuinely absent artifact is "missing". Existing but unreadable
    // data must be repaired explicitly instead of silently becoming Download.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        present: true,
        verified: false,
        verificationStatus: "invalid",
        sizeBytes: 0,
        expectedBytes,
        verifiedFiles: 0,
        expectedFiles: expectedEntries.length,
      };
    }
  }

  let sizeBytes = 0;
  let verifiedFiles = 0;
  for (const [filename, expected] of expectedEntries) {
    const filePath = path.join(modelDirectory, filename);
    try {
      const metadata = await lstat(filePath);
      if (!metadata.isFile()) continue;
      sizeBytes += metadata.size;
      if (metadata.size !== expected.bytes) continue;
      if (await sha256File(filePath, expected.bytes) === expected.sha256) {
        verifiedFiles += 1;
      }
    } catch {
      // Keep checking so diagnostics describe all expected manifest files.
    }
  }

  const verified = present && exactEntries && verifiedFiles === expectedEntries.length;
  return {
    present,
    verified,
    verificationStatus: verified ? "verified" : present ? "invalid" : "missing",
    sizeBytes,
    expectedBytes,
    verifiedFiles,
    expectedFiles: expectedEntries.length,
  };
}

/**
 * Metadata-only check that an artifact's every manifest file exists at its
 * pinned size.
 *
 * WARNING: a size match is not an integrity check. A file whose bytes were
 * corrupted in place — a bad sector, an interrupted copy, a partially rewritten
 * download — keeps its size and passes this function. Never use it to decide
 * whether a model may be loaded, and never use it to decide whether a *working*
 * model may be discarded in favour of this one. For that, use
 * `modelArtifactIsVerifiedNow`.
 *
 * It survives only as an early negative in status reporting, where the answer
 * "these files are not even present" is worth having without a hash.
 */
export async function modelArtifactIsPresent(
  modelRoot: string,
  model: ModelSpec,
): Promise<boolean> {
  if (await inspectModelRootDirectory(modelRoot) !== "safe") return false;
  const modelDirectory = path.join(modelRoot, model.storageDirectory);
  try {
    const directory = await lstat(modelDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    for (const [filename, expected] of Object.entries(model.files)) {
      const metadata = await lstat(path.join(modelDirectory, filename));
      if (!metadata.isFile() || metadata.size !== expected.bytes) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this artifact *proved* good, right now, without re-reading it?
 *
 * This exists because of a defect that could destroy a working setup. Auto's
 * tier selection runs at every recording boundary and could land on a
 * different tier of the same family. Switching tiers calls
 * `WorkerSupervisor.ensureReady`, which kills the running Python process
 * *before* asking the new one to load — that ordering is the "never two large
 * models resident at once" guarantee and is correct. The digest check happens
 * afterwards, inside the load.
 *
 * So the previous guard, a size-only probe, was load-bearing in a way it could
 * not support: a same-sized corrupted artifact passed it, the warm model was
 * killed, and the load then failed on the digest. The user lost a working model
 * and the dictation they were in the middle of, and got there through a file
 * that was never actually checked.
 *
 * The invariant this restores: *an artifact that has not been authoritatively
 * verified at its current file identity must never evict a working model.*
 *
 * It is cheap because it does not hash. It asks whether this exact file — same
 * device, inode, size, mtime, and ctime — is one that a full SHA-256 pass in
 * this process already matched against the manifest. `sha256File` records that
 * as it verifies, so an ordinary catalog refresh or a completed install
 * populates it. `ctime` is what makes the identity trustworthy: the kernel
 * stamps it on any in-place write and `utimes` cannot backdate it, so modified
 * content cannot masquerade as verified content.
 *
 * Answering "no" is always safe: it means Auto keeps the model that is already
 * working, and an explicit Apply still runs the full verification itself.
 */
export async function modelArtifactIsVerifiedNow(
  modelRoot: string,
  model: ModelSpec,
): Promise<boolean> {
  if (await inspectModelRootDirectory(modelRoot) !== "safe") return false;
  const modelDirectory = path.join(modelRoot, model.storageDirectory);
  const expectedEntries = Object.entries(model.files);
  try {
    const directory = await lstat(modelDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    // Exactly the manifest's entries, no more: an extra file means something
    // other than the curated install wrote here, whatever the digests say.
    // `isInertDirectoryMetadata` is the one narrow exception, because otherwise
    // a Finder visit to the models folder permanently blocks every model switch.
    const entries = await readdir(modelDirectory);
    const expectedNames = new Set(expectedEntries.map(([filename]) => filename));
    if (!await entrySetMatchesManifest(modelDirectory, entries, expectedNames)) return false;

    for (const [filename, expected] of expectedEntries) {
      const filePath = path.join(modelDirectory, filename);
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
      if (metadata.size !== expected.bytes) return false;
      const attested = digestByFileIdentity.get(filePath);
      if (!attested) return false;
      // The digest must be the manifest's, not merely *a* digest we once
      // computed for this path: the cache is keyed by path and a reinstall of a
      // different revision reuses paths.
      if (attested.digest !== expected.sha256) return false;
      const current = fileIdentity(await stat(filePath, { bigint: true }));
      if (!sameFileIdentity(attested, current)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The Python workers reject a symlinked/non-directory model root. Main uses
 * the same policy so status cannot bless external data that install/load would
 * reject, and removal cannot traverse an intermediate root symlink.
 */
export async function inspectModelRootDirectory(
  modelRoot: string,
): Promise<ModelRootDirectoryStatus> {
  try {
    const metadata = await lstat(modelRoot);
    return metadata.isDirectory() && !metadata.isSymbolicLink() ? "safe" : "invalid";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
  }
}

/** Verifies each distinct manifest-derived artifact once, then projects it onto its profiles. */
export async function verifyRuntimeModelCatalog(
  modelRoot: string,
  catalog: RuntimeModelCatalog,
  verifier: (root: string, model: ModelSpec) => Promise<ModelVerification> = verifyModelDirectory,
): Promise<ModelCatalogVerifications> {
  const verificationByManifestIdentity = new Map<string, Promise<ModelVerification>>();
  const entries = await Promise.all(MODEL_TIER_PRIORITY.map(async (tierName) => {
    const tier = catalog.tiers[tierName];
    const artifactKey = manifestArtifactIdentity(tier.manifest);
    let verification = verificationByManifestIdentity.get(artifactKey);
    if (!verification) {
      verification = verifier(modelRoot, tier.manifest);
      verificationByManifestIdentity.set(artifactKey, verification);
    }
    return [tierName, await verification] as const;
  }));
  return Object.fromEntries(entries) as ModelCatalogVerifications;
}

/**
 * Verifies every distinct artifact in the complete platform catalog.
 *
 * The result is keyed by family plus artifact identity rather than by profile:
 * Windows exposes three compute profiles over one physical CTranslate2 model,
 * while MLX uses a distinct artifact for each profile. Verification work is
 * also deduplicated by immutable manifest identity across the whole platform.
 */
export async function verifyRuntimePlatformModelCatalog(
  modelRoot: string,
  catalog: RuntimePlatformModelCatalog,
  verifier: (root: string, model: ModelSpec) => Promise<ModelVerification> = verifyModelDirectory,
): Promise<RuntimeModelArtifactVerification[]> {
  assertPlatformCatalogIsolation(catalog);
  const verificationByManifestIdentity = new Map<string, Promise<ModelVerification>>();
  const results: RuntimeModelArtifactVerification[] = [];

  for (const familyId of MODEL_FAMILY_IDS) {
    const family = catalog.families[familyId];
    assertCatalogRouting(family);
    assertCatalogArtifactIdentity(family);
    const seenArtifacts = new Set<string>();
    for (const tierName of MODEL_TIER_PRIORITY) {
      const tier = family.tiers[tierName];
      if (seenArtifacts.has(tier.artifactId)) continue;
      seenArtifacts.add(tier.artifactId);

      const identity = manifestArtifactIdentity(tier.manifest);
      let verification = verificationByManifestIdentity.get(identity);
      if (!verification) {
        verification = verifier(modelRoot, tier.manifest);
        verificationByManifestIdentity.set(identity, verification);
      }
      results.push({
        familyId,
        artifactId: tier.artifactId,
        ...await verification,
      });
    }
  }
  return results;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/**
 * Digests of files this process already hashed, keyed by exact file identity.
 *
 * The curated library is multiple gigabytes, and main hashes it whenever the
 * model screen, diagnostics, or an Apply refreshes catalog status. Re-reading
 * 6.1GB at the 2.57GB/s this machine sustains cost about 2.4s of main-thread
 * work per refresh, for files that had not changed.
 *
 * The key includes ctime, which the kernel stamps on any in-place write and
 * which `utimes` cannot backdate, so a modified file cannot present the
 * identity of the version that was hashed. Every structural check —
 * directory shape, symlink rejection, exact entry set, exact sizes — still runs
 * on every call; only the content read is skipped. And this cache is main's
 * status reporting only: the worker independently hashes each manifest file
 * inside `_valid_model_directory` before any load, so nothing enters memory on
 * the strength of a cached digest.
 */
const digestByFileIdentity = new Map<string, FileIdentity & { readonly digest: string }>();
const DIGEST_CACHE_LIMIT = 256;

function fileIdentity(stats: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

/** Test seam: drops every memoized digest so the next call re-reads from disk. */
export function forgetVerifiedModelDigests(): void {
  digestByFileIdentity.clear();
}

async function sha256File(filePath: string, expectedBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    const pathBefore = await lstat(filePath);
    if (
      !before.isFile()
      || !pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || before.dev !== pathBefore.dev
      || before.ino !== pathBefore.ino
      || before.size !== expectedBytes
      || pathBefore.size !== expectedBytes
    ) {
      throw new Error("Model file changed before verification");
    }

    const identity = fileIdentity(await handle.stat({ bigint: true }));
    const memoized = digestByFileIdentity.get(filePath);
    if (memoized && sameFileIdentity(memoized, identity)) return memoized.digest;

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(16 * 1024 * 1024);
    let totalBytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > expectedBytes) {
        throw new Error("Model file grew during verification");
      }
      digest.update(buffer.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    const pathAfter = await lstat(filePath);
    if (
      !after.isFile()
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || pathAfter.dev !== before.dev
      || pathAfter.ino !== before.ino
      || after.size !== expectedBytes
      || pathAfter.size !== expectedBytes
      || totalBytes !== expectedBytes
    ) {
      throw new Error("Model file changed during verification");
    }
    const hex = digest.digest("hex");
    // Re-read the identity after the content: caching what the file looked like
    // before the read could memoize a digest against a stale stamp.
    const identityAfter = fileIdentity(await handle.stat({ bigint: true }));
    if (sameFileIdentity(identity, identityAfter)) {
      if (digestByFileIdentity.size >= DIGEST_CACHE_LIMIT) digestByFileIdentity.clear();
      digestByFileIdentity.set(filePath, { ...identityAfter, digest: hex });
    }
    return hex;
  } finally {
    await handle.close();
  }
}
