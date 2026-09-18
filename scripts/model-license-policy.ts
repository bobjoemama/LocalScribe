import path from "node:path";
import { loadRuntimePlatformModelCatalog } from "../src/main/modelSpec";
import { resourcePolicyFor } from "../src/shared/platformResourcePolicy";

/** Validate the actual shipped catalog, never an environment-variable waiver. */
export function assertDistributableModelLicenses(projectPath: string): void {
  const policy = resourcePolicyFor("darwin", "arm64");
  const catalog = loadRuntimePlatformModelCatalog(
    path.join(projectPath, "resources/model-manifest"), "darwin", "arm64",
  );
  const catalogPaths = new Set<string>();
  for (const family of Object.values(catalog.families)) {
    for (const tier of Object.values(family.tiers)) {
      catalogPaths.add(`model-manifest/${tier.manifestFilename}`);
      // These declarations were reviewed for the curated artifacts, not for
      // arbitrary models with similarly named licenses or repositories.
      if (!["MIT", "Apache-2.0", "CC-BY-4.0"].includes(tier.manifest.license)) {
        throw new Error(`Unreviewed model license in ${tier.manifestFilename}; distribution blocked.`);
      }
    }
  }
  if (catalogPaths.size !== policy.manifestFiles.length
    || policy.manifestFiles.some((entry) => !catalogPaths.has(entry))) {
    throw new Error("Packaged manifests differ from the license-checked runtime catalog.");
  }
}
