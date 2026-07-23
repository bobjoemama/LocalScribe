import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type AcceleratorMemorySnapshot,
  type ModelPerformancePreference,
  type ModelPerformanceTier,
  type ModelResourceEvidenceKind,
} from "../shared/modelPerformance";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestFileSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: sha256Schema,
}).strict();

export const modelSpecSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.enum(["darwin-arm64", "win32-x64-cuda"]),
  backend: z.string().min(1).max(120),
  displayName: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  storageDirectory: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
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

export interface RuntimeModelCatalog {
  platform: ModelCatalogPlatform;
  engine: ModelEngine;
  tiers: Record<ModelPerformanceTier, RuntimeModelTierSpec>;
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

type PlatformCatalogDefinition = {
  [Platform in ModelCatalogPlatform]: {
    engine: ModelEngine;
    tiers: Record<ModelPerformanceTier, CatalogTierDefinition>;
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

const windowsModel = {
  manifestFilename: "faster-whisper-large-v3.json",
  engine: "faster-whisper",
  backend: "faster-whisper/CTranslate2",
  modelId: "Systran/faster-whisper-large-v3",
  storageDirectory: "faster-whisper-large-v3-edaa852",
  revision: "edaa852ec7e145841d8ffdb056a99866b5f0a478",
  expectedDownloadBytes: 3_090_835_702,
  downloadEvidence: immutableArtifactAudit(
    "Systran/faster-whisper-large-v3",
    "edaa852ec7e145841d8ffdb056a99866b5f0a478",
  ),
} as const;

export const MODEL_CATALOG_DEFINITIONS = {
  "darwin-arm64": {
    engine: "mlx-whisper",
    tiers: {
      high: {
        manifestFilename: "whisper-large-v3-mlx.json",
        engine: "mlx-whisper",
        backend: "MLX Whisper",
        precision: "fp16",
        modelId: "mlx-community/whisper-large-v3-mlx",
        storageDirectory: "whisper-large-v3-mlx-49e6aa2",
        revision: "49e6aa286ad60c14352c404340ded53710378a11",
        expectedDownloadBytes: 3_083_520_685,
        downloadEvidence: immutableArtifactAudit(
          "mlx-community/whisper-large-v3-mlx",
          "49e6aa286ad60c14352c404340ded53710378a11",
        ),
        acceleratorMemory: estimatedMemory(
          "MLX Whisper large-v3 FP16 artifact size plus conservative inference overhead; benchmark pending",
          4,
          5.5,
        ),
      },
      medium: {
        manifestFilename: "whisper-large-v3-mlx-8bit.json",
        engine: "mlx-whisper",
        backend: "MLX Whisper",
        precision: "8-bit",
        modelId: "mlx-community/whisper-large-v3-mlx-8bit",
        storageDirectory: "whisper-large-v3-mlx-8bit-04ca5b0",
        revision: "04ca5b03c22d72ddf4f4b2d808a28bf9902fb71a",
        expectedDownloadBytes: 1_707_566_582,
        downloadEvidence: immutableArtifactAudit(
          "mlx-community/whisper-large-v3-mlx-8bit",
          "04ca5b03c22d72ddf4f4b2d808a28bf9902fb71a",
        ),
        acceleratorMemory: estimatedMemory(
          "MLX Whisper large-v3 8-bit artifact size plus conservative inference overhead; benchmark pending",
          2.5,
          3.5,
        ),
      },
      low: {
        manifestFilename: "whisper-large-v3-mlx-4bit.json",
        engine: "mlx-whisper",
        backend: "MLX Whisper",
        precision: "4-bit",
        modelId: "mlx-community/whisper-large-v3-mlx-4bit",
        storageDirectory: "whisper-large-v3-mlx-4bit-d12b5d0",
        revision: "d12b5d0043a6fe0c59af321617fba041d4e8e0c8",
        expectedDownloadBytes: 973_563_382,
        downloadEvidence: immutableArtifactAudit(
          "mlx-community/whisper-large-v3-mlx-4bit",
          "d12b5d0043a6fe0c59af321617fba041d4e8e0c8",
        ),
        acceleratorMemory: estimatedMemory(
          "MLX Whisper large-v3 4-bit artifact size plus conservative inference overhead; benchmark pending",
          1.8,
          2.7,
        ),
      },
    },
  },
  "win32-x64-cuda": {
    engine: "faster-whisper",
    tiers: {
      high: {
        ...windowsModel,
        precision: "float16",
        acceleratorMemory: estimatedMemory(
          "CTranslate2 large-v3 float16 weights plus conservative CUDA inference overhead; physical benchmark pending",
          4.5,
          5.5,
        ),
      },
      medium: {
        ...windowsModel,
        precision: "int8_float16",
        acceleratorMemory: estimatedMemory(
          "CTranslate2 large-v3 int8_float16 weights plus conservative CUDA inference overhead; physical benchmark pending",
          2.9,
          3.5,
        ),
      },
      low: {
        ...windowsModel,
        precision: "int8",
        acceleratorMemory: estimatedMemory(
          "CTranslate2 large-v3 int8 weights plus conservative CUDA inference overhead; physical benchmark pending",
          2.6,
          3.3,
        ),
      },
    },
  },
} as const satisfies PlatformCatalogDefinition;

export function manifestPlatformForRuntime(platform: NodeJS.Platform, architecture: string): ModelSpec["platform"] {
  if (platform === "darwin" && architecture === "arm64") return "darwin-arm64";
  if (platform === "win32" && architecture === "x64") return "win32-x64-cuda";
  throw new Error(`LocalScribe has no packaged model manifest for ${platform}/${architecture}`);
}

export function modelManifestPath(
  manifestDirectory: string,
  platform: NodeJS.Platform,
  architecture: string,
  tier: ModelPerformanceTier = "medium",
): string {
  const manifestPlatform = manifestPlatformForRuntime(platform, architecture);
  return path.join(
    manifestDirectory,
    MODEL_CATALOG_DEFINITIONS[manifestPlatform].tiers[tier].manifestFilename,
  );
}

export function loadModelSpec(
  manifestPath: string,
  expectedPlatform: ModelSpec["platform"],
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

export function loadRuntimeModelSpec(
  manifestDirectory: string,
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch,
  tier: ModelPerformanceTier = "medium",
): ModelSpec {
  const expectedPlatform = manifestPlatformForRuntime(platform, architecture);
  const definition = MODEL_CATALOG_DEFINITIONS[expectedPlatform].tiers[tier];
  const manifest = loadModelSpec(
    modelManifestPath(manifestDirectory, platform, architecture, tier),
    expectedPlatform,
  );
  assertManifestMatchesCatalog(manifest, definition, tier);
  return manifest;
}

export function loadRuntimeModelCatalog(
  manifestDirectory: string,
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch,
): RuntimeModelCatalog {
  const catalogPlatform = manifestPlatformForRuntime(platform, architecture);
  const definition = MODEL_CATALOG_DEFINITIONS[catalogPlatform];
  const entries = Object.entries(definition.tiers).map(([tierValue, tierDefinition]) => {
    const tier = tierValue as ModelPerformanceTier;
    const manifest = loadModelSpec(
      path.join(manifestDirectory, tierDefinition.manifestFilename),
      catalogPlatform,
    );
    assertManifestMatchesCatalog(manifest, tierDefinition, tier);
    return [
      tier,
      {
        tier,
        modelKey: tier,
        engine: tierDefinition.engine,
        precision: tierDefinition.precision,
        expectedDownloadBytes: tierDefinition.expectedDownloadBytes,
        downloadEvidence: tierDefinition.downloadEvidence,
        acceleratorMemory: tierDefinition.acceleratorMemory,
        manifestFilename: tierDefinition.manifestFilename,
        manifest,
      },
    ] as const;
  });

  const catalog = {
    platform: catalogPlatform,
    engine: definition.engine,
    tiers: Object.fromEntries(entries) as Record<ModelPerformanceTier, RuntimeModelTierSpec>,
  };
  assertCatalogArtifactIdentity(catalog);
  return catalog;
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
    return buildResolution(
      input,
      input.activeDictationTier,
      "dictation-active",
      memory,
      headroom,
    );
  }

  if (input.preference !== "auto") {
    return buildResolution(input, input.preference, "explicit", memory, headroom);
  }

  const baseFit = (tier: ModelPerformanceTier) => tierFitsMemory(
    input.catalog.tiers[tier],
    memory,
    headroom,
    0,
  );
  const highestBaseFit = MODEL_TIER_PRIORITY.find(baseFit);

  if (!highestBaseFit) {
    return buildResolution(
      input,
      "low",
      "auto-insufficient-memory",
      memory,
      headroom,
    );
  }

  if (!input.previousTier || !baseFit(input.previousTier)) {
    return buildResolution(
      input,
      highestBaseFit,
      "auto-highest-fit",
      memory,
      headroom,
    );
  }

  const previousIndex = MODEL_TIER_PRIORITY.indexOf(input.previousTier);
  const upgrade = MODEL_TIER_PRIORITY
    .slice(0, previousIndex)
    .find((tier) => tierFitsMemory(
      input.catalog.tiers[tier],
      memory,
      headroom,
      AUTO_UPGRADE_HYSTERESIS_BYTES,
    ));

  if (upgrade) {
    return buildResolution(input, upgrade, "auto-highest-fit", memory, headroom);
  }

  const highestBaseFitIndex = MODEL_TIER_PRIORITY.indexOf(highestBaseFit);
  if (highestBaseFitIndex > previousIndex) {
    return buildResolution(
      input,
      highestBaseFit,
      "auto-highest-fit",
      memory,
      headroom,
    );
  }

  return buildResolution(
    input,
    input.previousTier,
    "auto-hysteresis-hold",
    memory,
    headroom,
  );
}

const MODEL_TIER_PRIORITY: readonly ModelPerformanceTier[] = ["high", "medium", "low"];

function assertCatalogRouting(catalog: RuntimeModelCatalog): void {
  for (const tierName of MODEL_TIER_PRIORITY) {
    const tier = catalog.tiers[tierName];
    if (
      tier.tier !== tierName
      || tier.modelKey !== tierName
      || tier.engine !== catalog.engine
      || tier.manifest.platform !== catalog.platform
    ) {
      throw new Error(
        `Model catalog ${catalog.platform}/${tierName} crosses a platform, engine, or tier routing boundary`,
      );
    }
  }
}

function assertCatalogArtifactIdentity(catalog: RuntimeModelCatalog): void {
  const pairs = [
    ["high", "medium"],
    ["high", "low"],
    ["medium", "low"],
  ] as const satisfies readonly (readonly [ModelPerformanceTier, ModelPerformanceTier])[];
  for (const [leftTier, rightTier] of pairs) {
    const left = catalog.tiers[leftTier];
    const right = catalog.tiers[rightTier];
    const sharesAnyIdentity = left.manifest.modelId === right.manifest.modelId
      || left.manifest.revision === right.manifest.revision
      || left.manifest.storageDirectory === right.manifest.storageDirectory;
    if (
      sharesAnyIdentity
      && JSON.stringify(left.manifest) !== JSON.stringify(right.manifest)
    ) {
      throw new Error(
        `Packaged ${catalog.platform} tiers ${left.tier} and ${right.tier} partially reuse a physical artifact; shared artifact identity requires identical manifests and digests`,
      );
    }
  }
}

function assertManifestMatchesCatalog(
  manifest: ModelSpec,
  definition: CatalogTierDefinition,
  tier: ModelPerformanceTier,
): void {
  const expected = {
    backend: definition.backend,
    modelId: definition.modelId,
    storageDirectory: definition.storageDirectory,
    revision: definition.revision,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field as keyof typeof expected] !== value) {
      throw new Error(
        `Packaged ${tier} model manifest ${field} mismatch: expected ${value}, received ${manifest[field as keyof typeof expected]}`,
      );
    }
  }
  const actualDownloadBytes = Object.values(manifest.files)
    .reduce((sum, file) => sum + file.bytes, 0);
  if (actualDownloadBytes !== definition.expectedDownloadBytes) {
    throw new Error(
      `Packaged ${tier} model download size mismatch: expected ${definition.expectedDownloadBytes}, received ${actualDownloadBytes}`,
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

function tierFitsMemory(
  tier: RuntimeModelTierSpec,
  memory: AcceleratorMemorySnapshot,
  headroomBytes: number | null,
  additionalFreeHeadroomBytes: number,
): boolean {
  if (
    memory.totalBytes === null
    || memory.freeBytes === null
    || headroomBytes === null
  ) {
    return false;
  }
  const required = tier.acceleratorMemory.maximumBytes + headroomBytes;
  return memory.totalBytes >= required
    && memory.freeBytes >= required + additionalFreeHeadroomBytes;
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
  };
}

export async function verifyModelDirectory(
  modelRoot: string,
  model: ModelSpec,
): Promise<ModelVerification> {
  const modelDirectory = path.join(modelRoot, model.storageDirectory);
  const expectedEntries = Object.entries(model.files);
  const expectedBytes = expectedEntries.reduce((sum, [, file]) => sum + file.bytes, 0);
  let present = false;
  try {
    present = (await lstat(modelDirectory)).isDirectory();
  } catch {
    // A missing directory is an ordinary pre-install state.
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
      // Keep checking remaining files so diagnostics describe the complete local state.
    }
  }

  const verified = present && verifiedFiles === expectedEntries.length;
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
 * Verifies each distinct on-disk artifact once, then projects the result onto
 * every compute tier that shares it (the three Windows modes intentionally do).
 */
export async function verifyRuntimeModelCatalog(
  modelRoot: string,
  catalog: RuntimeModelCatalog,
  verifier: (root: string, model: ModelSpec) => Promise<ModelVerification> = verifyModelDirectory,
): Promise<ModelCatalogVerifications> {
  const verificationByArtifact = new Map<string, Promise<ModelVerification>>();
  const entries = await Promise.all(
    MODEL_TIER_PRIORITY.map(async (tierName) => {
      const tier = catalog.tiers[tierName];
      const artifactKey = [
        tier.manifest.modelId,
        tier.manifest.revision,
        tier.manifest.storageDirectory,
      ].join("\u0000");
      let verification = verificationByArtifact.get(artifactKey);
      if (!verification) {
        verification = verifier(modelRoot, tier.manifest);
        verificationByArtifact.set(artifactKey, verification);
      }
      return [tierName, await verification] as const;
    }),
  );
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
