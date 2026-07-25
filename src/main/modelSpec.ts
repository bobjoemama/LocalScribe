import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
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
  const expectedEngine: ModelEngine = catalog.platform === "darwin-arm64"
    ? "mlx-whisper"
    : "faster-whisper";
  const expectedPrecisions: Record<ModelPerformanceTier, ModelPrecision> = expectedEngine === "mlx-whisper"
    ? { high: "fp16", medium: "8-bit", low: "4-bit" }
    : { high: "float16", medium: "int8_float16", low: "int8" };
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
      || tier.precision !== expectedPrecisions[tierName]
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
  const expectedBackend = definition.engine === "mlx-whisper"
    ? "MLX Whisper"
    : "faster-whisper/CTranslate2";
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
    exactEntries = entries.length === expectedNames.size && entries.every((entry) => expectedNames.has(entry));
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
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}
