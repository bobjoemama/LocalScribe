import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import {
  MODEL_FAMILY_IDS,
  type ModelCatalog,
  type ModelFamilyId,
} from "../shared/contracts";
import {
  verifyRuntimePlatformModelCatalog,
  inspectModelRootDirectory,
  type RuntimeModelTierSpec,
  type RuntimePlatformModelCatalog,
} from "./modelSpec";

export interface ModelCatalogSettings {
  activeModelFamilyId: ModelFamilyId;
  modelLibraryFamilyIds: ModelFamilyId[];
}

/**
 * Builds the renderer-safe model-management snapshot from main-owned settings,
 * the immutable packaged catalog, and current on-disk verification.
 */
export async function buildModelCatalogSnapshot(input: {
  settings: ModelCatalogSettings;
  catalog: RuntimePlatformModelCatalog;
  modelRoot: string;
}): Promise<ModelCatalog> {
  const { settings, catalog, modelRoot } = input;
  const [verifications, unmanagedEntries] = await Promise.all([
    verifyRuntimePlatformModelCatalog(modelRoot, catalog),
    listUnmanagedModelEntries(modelRoot, catalog),
  ]);
  return {
    platform: catalog.platform,
    activeModelFamilyId: settings.activeModelFamilyId,
    modelLibraryFamilyIds: settings.modelLibraryFamilyIds,
    families: MODEL_FAMILY_IDS.map((familyId) => {
      const family = catalog.families[familyId];
      const artifacts = new Map<string, RuntimeModelTierSpec>();
      for (const tier of Object.values(family.tiers)) artifacts.set(tier.artifactId, tier);
      return {
        familyId,
        displayName: family.displayName,
        active: familyId === settings.activeModelFamilyId,
        inLibrary: settings.modelLibraryFamilyIds.includes(familyId),
        artifacts: [...artifacts.values()].map((tier) => ({
          artifactId: tier.artifactId,
          displayName: tier.manifest.displayName,
          backend: tier.manifest.backend,
          modelId: tier.manifest.modelId,
          storageDirectory: tier.manifest.storageDirectory,
          revision: tier.manifest.revision,
          license: tier.manifest.license,
          expectedDownloadBytes: tier.expectedDownloadBytes,
        })),
        profiles: Object.values(family.tiers).map((tier) => ({
          profileId: tier.profileId,
          tier: tier.tier,
          artifactId: tier.artifactId,
          engine: tier.engine,
          precision: tier.precision,
          expectedMemoryMinBytes: tier.acceleratorMemory.minimumBytes,
          expectedMemoryMaxBytes: tier.acceleratorMemory.maximumBytes,
          memoryBasis: tier.acceleratorMemory.evidence.kind,
        })),
      };
    }),
    verifications,
    unmanagedEntries,
  };
}

/** The model root is always a child of Electron's app-owned userData path. */
export function modelRootForUserData(userDataPath: string): string {
  return path.join(userDataPath, "models");
}

const MAX_INVENTORY_WALK_ENTRIES = 100_000;

async function listUnmanagedModelEntries(
  modelRoot: string,
  catalog: RuntimePlatformModelCatalog,
): Promise<ModelCatalog["unmanagedEntries"]> {
  if (await inspectModelRootDirectory(modelRoot) !== "safe") return [];
  const curated = new Set<string>();
  for (const family of Object.values(catalog.families)) {
    for (const tier of Object.values(family.tiers)) {
      curated.add(tier.manifest.storageDirectory);
    }
  }

  let entries;
  try {
    entries = await readdir(modelRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const unmanaged = entries
    .filter((entry) => !curated.has(entry.name))
    .slice(0, 1_000);
  return Promise.all(unmanaged.map(async (entry) => {
    const entryPath = path.join(modelRoot, entry.name);
    const kind = entry.isSymbolicLink()
      ? "symlink" as const
      : entry.isDirectory()
        ? "directory" as const
        : entry.isFile()
          ? "file" as const
          : "other" as const;
    return {
      name: entry.name,
      kind,
      reason: interruptedTransactionName(entry.name)
        ? "interrupted-install" as const
        : "unmanaged" as const,
      sizeBytes: kind === "symlink" || kind === "other"
        ? null
        : await boundedEntrySize(entryPath),
    };
  }));
}

function interruptedTransactionName(name: string): boolean {
  return /^\.localscribe-model-install-[a-f0-9]{32}$/.test(name)
    || /^\.whisper-(?:high|medium|low)-staging-[a-z0-9_-]+$/.test(name)
    || /^\.replaced-(?:high|medium|low)-[a-f0-9]+$/.test(name)
    || /^\.faster-whisper-(?:staging|replaced)-[a-z0-9_-]+$/.test(name);
}

async function boundedEntrySize(entryPath: string): Promise<number | null> {
  const queue = [entryPath];
  let visited = 0;
  let total = 0;
  try {
    while (queue.length > 0) {
      const next = queue.pop();
      if (!next) break;
      visited += 1;
      if (visited > MAX_INVENTORY_WALK_ENTRIES) return null;
      const metadata = await lstat(next);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isFile()) {
        total += metadata.size;
        if (!Number.isSafeInteger(total)) return null;
        continue;
      }
      if (!metadata.isDirectory()) continue;
      const children = await readdir(next);
      for (const child of children) queue.push(path.join(next, child));
    }
    return total;
  } catch {
    return null;
  }
}
