import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
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
  modelId: z.string().min(1).max(200),
  storageDirectory: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  // "Undeclared" is intentional when an audited artifact provides no license
  // metadata; do not infer a project-wide license from another model family.
  license: z.string().min(1).max(120),
  files: z.record(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    manifestFileSchema,
  ).refine((files) => Object.keys(files).length > 0, "a model manifest must list files"),
}).strict();

export type ModelSpec = z.infer<typeof modelSpecSchema>;
export type ModelVerificationStatus = "missing" | "invalid" | "verified";
export type ModelCatalogPlatform = ModelSpec["platform"];
export type ModelEngine = "mlx-whisper" | "faster-whisper";
export type ModelPrecision = "fp16" | "8-bit" | "4-bit" | "float16" | "int8_float16" | "int8";

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
  /** Required free accelerator memory including reserved Auto headroom. */
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

const GIBIBYTE = 1024 ** 3;
const AUTO_MINIMUM_HEADROOM_BYTES = 2 * GIBIBYTE;
const AUTO_HEADROOM_FRACTION = 0.2;
const AUTO_UPGRADE_HYSTERESIS_BYTES = GIBIBYTE;

interface CatalogTierDefinition {
  artifactId: string;
  profileId: string;
  manifestFilename: string;
  engine: ModelEngine;
  backend: string;
  precision: ModelPrecision;
  modelId: string;
  storageDirectory: string;
  revision: string;
  expectedDownloadBytes: number;
  downloadEvidence: ModelResourceEvidence;
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
  tier: ModelPerformanceTier,
  input: {
    artifactId: string;
    manifestFilename: string;
    precision: "fp16" | "8-bit" | "4-bit";
    modelId: string;
    storageDirectory: string;
    revision: string;
    expectedDownloadBytes: number;
    memory: readonly [number, number];
  },
): CatalogTierDefinition => ({
  artifactId: input.artifactId,
  profileId: `${familyId}-${tier}`,
  manifestFilename: input.manifestFilename,
  engine: "mlx-whisper",
  backend: "MLX Whisper",
  precision: input.precision,
  modelId: input.modelId,
  storageDirectory: input.storageDirectory,
  revision: input.revision,
  expectedDownloadBytes: input.expectedDownloadBytes,
  downloadEvidence: immutableArtifactAudit(input.modelId, input.revision),
  acceleratorMemory: estimatedMemory(
    `MLX Whisper ${familyId} ${input.precision} artifact size plus conservative inference overhead; physical benchmark pending`,
    input.memory[0],
    input.memory[1],
  ),
});

const windowsTier = (
  familyId: ModelFamilyId,
  tier: ModelPerformanceTier,
  precision: "float16" | "int8_float16" | "int8",
  input: {
    artifactId: string;
    manifestFilename: string;
    modelId: string;
    storageDirectory: string;
    revision: string;
    expectedDownloadBytes: number;
    memory: readonly [number, number];
  },
): CatalogTierDefinition => ({
  artifactId: input.artifactId,
  profileId: `${familyId}-${tier}`,
  manifestFilename: input.manifestFilename,
  engine: "faster-whisper",
  backend: "faster-whisper/CTranslate2",
  precision,
  modelId: input.modelId,
  storageDirectory: input.storageDirectory,
  revision: input.revision,
  expectedDownloadBytes: input.expectedDownloadBytes,
  downloadEvidence: immutableArtifactAudit(input.modelId, input.revision),
  acceleratorMemory: estimatedMemory(
    `CTranslate2 ${familyId} ${precision} weights plus conservative CUDA inference overhead; physical benchmark pending`,
    input.memory[0],
    input.memory[1],
  ),
});

const v3Mac: FamilyCatalogDefinition = {
  familyId: "whisper-large-v3",
  displayName: "Whisper large-v3",
  engine: "mlx-whisper",
  tiers: {
    high: mlxTier("whisper-large-v3", "high", {
      artifactId: "whisper-large-v3-mlx-fp16",
      manifestFilename: "whisper-large-v3-mlx.json",
      precision: "fp16",
      modelId: "mlx-community/whisper-large-v3-mlx",
      storageDirectory: "whisper-large-v3-mlx-49e6aa2",
      revision: "49e6aa286ad60c14352c404340ded53710378a11",
      expectedDownloadBytes: 3_083_520_685,
      memory: [4, 5.5],
    }),
    medium: mlxTier("whisper-large-v3", "medium", {
      artifactId: "whisper-large-v3-mlx-int8",
      manifestFilename: "whisper-large-v3-mlx-8bit.json",
      precision: "8-bit",
      modelId: "mlx-community/whisper-large-v3-mlx-8bit",
      storageDirectory: "whisper-large-v3-mlx-8bit-04ca5b0",
      revision: "04ca5b03c22d72ddf4f4b2d808a28bf9902fb71a",
      expectedDownloadBytes: 1_707_566_582,
      memory: [2.5, 3.5],
    }),
    low: mlxTier("whisper-large-v3", "low", {
      artifactId: "whisper-large-v3-mlx-int4",
      manifestFilename: "whisper-large-v3-mlx-4bit.json",
      precision: "4-bit",
      modelId: "mlx-community/whisper-large-v3-mlx-4bit",
      storageDirectory: "whisper-large-v3-mlx-4bit-d12b5d0",
      revision: "d12b5d0043a6fe0c59af321617fba041d4e8e0c8",
      expectedDownloadBytes: 973_563_382,
      memory: [1.8, 2.7],
    }),
  },
};

const v2Mac: FamilyCatalogDefinition = {
  familyId: "whisper-large-v2",
  displayName: "Whisper large-v2",
  engine: "mlx-whisper",
  tiers: {
    high: mlxTier("whisper-large-v2", "high", {
      artifactId: "whisper-large-v2-mlx-fp16",
      manifestFilename: "whisper-large-v2-mlx.json",
      precision: "fp16",
      modelId: "mlx-community/whisper-large-v2-mlx",
      storageDirectory: "whisper-large-v2-mlx-cce8622",
      revision: "cce86229e2765266197fef869ce9f7e2550067ab",
      expectedDownloadBytes: 3_083_149_692,
      memory: [4, 5.5],
    }),
    medium: mlxTier("whisper-large-v2", "medium", {
      artifactId: "whisper-large-v2-mlx-int8",
      manifestFilename: "whisper-large-v2-mlx-8bit.json",
      precision: "8-bit",
      modelId: "mlx-community/whisper-large-v2-mlx-8bit",
      storageDirectory: "whisper-large-v2-mlx-8bit-ee1ab58",
      revision: "ee1ab587ec0827941f04d9bb0ff9c2005444ef80",
      expectedDownloadBytes: 1_707_195_589,
      memory: [2.5, 3.5],
    }),
    low: mlxTier("whisper-large-v2", "low", {
      artifactId: "whisper-large-v2-mlx-int4",
      manifestFilename: "whisper-large-v2-mlx-4bit.json",
      precision: "4-bit",
      modelId: "mlx-community/whisper-large-v2-mlx-4bit",
      storageDirectory: "whisper-large-v2-mlx-4bit-79e71f0",
      revision: "79e71f0c4946290e517db80c7a5cba6f91bdfcaf",
      expectedDownloadBytes: 973_192_389,
      memory: [1.8, 2.7],
    }),
  },
};

const v3WindowsArtifact = {
  artifactId: "whisper-large-v3-ctranslate2",
  manifestFilename: "faster-whisper-large-v3.json",
  modelId: "Systran/faster-whisper-large-v3",
  storageDirectory: "faster-whisper-large-v3-edaa852",
  revision: "edaa852ec7e145841d8ffdb056a99866b5f0a478",
  expectedDownloadBytes: 3_090_835_702,
} as const;

const v2WindowsArtifact = {
  artifactId: "whisper-large-v2-ctranslate2",
  manifestFilename: "faster-whisper-large-v2.json",
  modelId: "Systran/faster-whisper-large-v2",
  storageDirectory: "faster-whisper-large-v2-f0fe815",
  revision: "f0fe81560cb8b68660e564f55dd99207059c092e",
  expectedDownloadBytes: 3_089_578_858,
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
    high: windowsTier(familyId, "high", "float16", { ...artifact, memory: [4.5, 5.5] }),
    medium: windowsTier(familyId, "medium", "int8_float16", { ...artifact, memory: [2.9, 3.5] }),
    low: windowsTier(familyId, "low", "int8", { ...artifact, memory: [2.6, 3.3] }),
  },
});

/** Every shipped family is declared for both supported runtime platforms. */
export const MODEL_CATALOG_DEFINITIONS = {
  "darwin-arm64": {
    families: {
      "whisper-large-v3": v3Mac,
      "whisper-large-v2": v2Mac,
    },
  },
  "win32-x64-cuda": {
    families: {
      "whisper-large-v3": windowsFamily("whisper-large-v3", "Whisper large-v3", v3WindowsArtifact),
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
      return [tier, {
        familyId,
        artifactId: tierDefinition.artifactId,
        profileId: tierDefinition.profileId,
        tier,
        modelKey: tier,
        engine: tierDefinition.engine,
        precision: tierDefinition.precision,
        expectedDownloadBytes: tierDefinition.expectedDownloadBytes,
        downloadEvidence: tierDefinition.downloadEvidence,
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
  return {
    platform: catalogPlatform,
    families: families as Record<ModelFamilyId, RuntimeModelCatalog>,
  };
}

export function resolveModelPerformance(
  input: ResolveModelPerformanceInput,
): ModelPerformanceResolution {
  assertCatalogRouting(input.catalog);
  const memory = normalizeMemorySnapshot(input.memory);
  const headroom = memory.totalBytes === null
    ? null
    : Math.max(AUTO_MINIMUM_HEADROOM_BYTES, Math.ceil(memory.totalBytes * AUTO_HEADROOM_FRACTION));

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
  for (const tierName of MODEL_TIER_PRIORITY) {
    const tier = catalog.tiers[tierName];
    if (
      tier.tier !== tierName
      || tier.modelKey !== tierName
      || tier.familyId !== catalog.familyId
      || tier.manifest.familyId !== catalog.familyId
      || tier.artifactId !== tier.manifest.artifactId
      || tier.engine !== catalog.engine
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

function assertManifestMatchesCatalog(
  manifest: ModelSpec,
  family: FamilyCatalogDefinition,
  definition: CatalogTierDefinition,
  tier: ModelPerformanceTier,
): void {
  const expected = {
    familyId: family.familyId,
    artifactId: definition.artifactId,
    backend: definition.backend,
    modelId: definition.modelId,
    storageDirectory: definition.storageDirectory,
    revision: definition.revision,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field as keyof typeof expected] !== value) {
      throw new Error(
        `Packaged ${family.familyId}/${tier} model manifest ${field} mismatch: expected ${value}, received ${manifest[field as keyof typeof expected]}`,
      );
    }
  }
  const actualDownloadBytes = Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0);
  if (actualDownloadBytes !== definition.expectedDownloadBytes) {
    throw new Error(
      `Packaged ${family.familyId}/${tier} model download size mismatch: expected ${definition.expectedDownloadBytes}, received ${actualDownloadBytes}`,
    );
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
 * A verified directory must contain exactly the files in the immutable
 * manifest. Extra files, directories, or symlinks make it invalid rather
 * than silently trusting a mixed artifact.
 */
export async function verifyModelDirectory(
  modelRoot: string,
  model: ModelSpec,
): Promise<ModelVerification> {
  const modelDirectory = path.join(modelRoot, model.storageDirectory);
  const expectedEntries = Object.entries(model.files);
  const expectedNames = new Set(expectedEntries.map(([filename]) => filename));
  const expectedBytes = expectedEntries.reduce((sum, [, file]) => sum + file.bytes, 0);
  let present = false;
  let exactEntries = false;
  try {
    present = (await lstat(modelDirectory)).isDirectory();
    if (present) {
      const entries = await readdir(modelDirectory);
      exactEntries = entries.length === expectedNames.size && entries.every((entry) => expectedNames.has(entry));
    }
  } catch {
    // A missing or unreadable directory is an ordinary pre-install/invalid state.
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
      if (await sha256File(filePath) === expected.sha256) verifiedFiles += 1;
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

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}
