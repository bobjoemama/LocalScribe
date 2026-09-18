import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRuntimePlatformModelCatalog } from "../src/main/modelSpec";
import { buildModelCatalogSnapshot } from "../src/main/modelCatalogSnapshot";
import { MODEL_FAMILY_IDS, type ModelCatalog } from "../src/shared/contracts";
import { MODEL_EVIDENCE, modelArtifactSourceUrl } from "../src/shared/modelEvidence";
import { MODEL_SORT_OPTIONS, isModelSortOrder, modelComparisonValues, orderModelFamilies } from "../src/renderer/settings/screens/modelOrdering";
import { validateBenchmarkSnapshot, validateRemoteFile, validateSourceIdentity } from "../scripts/audit-model-sources.mts";

let root: string;
let families: ModelCatalog["families"];
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "localscribe-order-test-"));
  const catalog = loadRuntimePlatformModelCatalog(path.resolve("resources/model-manifest"), "darwin", "arm64");
  families = (await buildModelCatalogSnapshot({
    settings: { activeModelFamilyId: "parakeet-unified-en-0-6b", modelLibraryFamilyIds: ["parakeet-unified-en-0-6b"] },
    catalog, modelRoot: root,
  })).families;
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("model ordering", () => {
  it.each(MODEL_SORT_OPTIONS)("orders $id without mutating the catalog or selecting models", ({ id }) => {
    const before = JSON.stringify(families);
    const ordered = orderModelFamilies(families, id, "high", "after-stop");
    expect(new Set(ordered.map((family) => family.familyId))).toEqual(new Set(families.map((family) => family.familyId)));
    expect(JSON.stringify(families)).toBe(before);
    expect(ordered).not.toBe(families);
  });

  it.each(["memory", "download", "wer", "speed"] as const)("sorts %s numerically in both directions with missing values last", (metric) => {
    for (const tier of ["high", "medium", "low"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        const values = orderModelFamilies(families, `${metric}-${direction}`, tier, "after-stop")
          .map((family) => modelComparisonValues(family, tier, "after-stop")[metric]);
        const reported = values.filter((value): value is number => value !== null);
        expect(reported).toEqual([...reported].sort((a, b) => (a - b) * (direction === "asc" ? 1 : -1)));
        expect(values.slice(reported.length).every((value) => value === null)).toBe(true);
      }
    }
  });

  it("does not invent a Low Parakeet or turn offline results into Live evidence", () => {
    const parakeet = families.find((family) => family.familyId === "parakeet-unified-en-0-6b")!;
    expect(modelComparisonValues(parakeet, "low", "live")).toEqual({ memory: null, download: null, wer: null, speed: null });
    const qwen = families.find((family) => family.familyId === "qwen3-asr-1-7b")!;
    expect(modelComparisonValues(qwen, "high", "live").wer).toBeNull();
    for (const { id } of MODEL_SORT_OPTIONS) {
      expect(orderModelFamilies(families, id, "high", "live").map((family) => family.familyId)).toEqual([parakeet.familyId]);
    }
  });

  it("preserves ties and unknown order, and restores curated order", () => {
    expect(orderModelFamilies(families, "recommended", "low", "after-stop")).toEqual(families);
    const unknown = families.filter((family) => MODEL_EVIDENCE[family.familyId].reference === null);
    expect(orderModelFamilies(unknown, "wer-desc", "high", "after-stop")).toEqual(unknown);
    const tied = families.map((family) => ({ ...family, profiles: family.profiles.map((profile) => ({ ...profile, expectedMemoryMaxBytes: 123 })) }));
    expect(orderModelFamilies(tied, "memory-asc", "high", "after-stop")).toEqual(tied);
    expect(orderModelFamilies([], "speed-asc", "high", "after-stop")).toEqual([]);
    expect(isModelSortOrder("speed-desc")).toBe(true);
    expect(isModelSortOrder("constructor")).toBe(false);
  });
});

describe("model evidence and download source audit", () => {
  it("covers every real artifact with an immutable canonical Hub source and disclosed publisher", () => {
    expect(Object.keys(MODEL_EVIDENCE).sort()).toEqual([...MODEL_FAMILY_IDS].sort());
    for (const family of families) for (const artifact of family.artifacts) {
      expect(artifact.modelId.split("/")[0]).toBe(MODEL_EVIDENCE[family.familyId].artifactPublisher);
      expect(modelArtifactSourceUrl(artifact.modelId, artifact.revision)).toBe(`https://huggingface.co/${artifact.modelId}/tree/${artifact.revision}`);
    }
  });

  it.each(["https://evil.test/a", "mlx-community/a/../../evil", "mlx-community/a?x=1", "mlx-community/a#x", "other/a"])("rejects uncurated URL input %s", (modelId) => {
    expect(modelArtifactSourceUrl(modelId, "a".repeat(40))).toBeNull();
  });

  it("rejects mutable revisions, mismatched identities and unverified digests", () => {
    expect(modelArtifactSourceUrl("mlx-community/model", "main")).toBeNull();
    const manifest = { familyId: "whisper-large-v3" as const, modelId: "mlx-community/model", revision: "a".repeat(40), files: {} };
    const metadata = { id: manifest.modelId, sha: manifest.revision, siblings: [] };
    expect(() => validateSourceIdentity(manifest, metadata)).not.toThrow();
    expect(() => validateSourceIdentity(manifest, { ...metadata, sha: "b".repeat(40) })).toThrow();
    expect(() => validateSourceIdentity({ ...manifest, familyId: "canary-qwen-2-5b" }, metadata)).toThrow();
    const expected = { bytes: 123, sha256: "c".repeat(64) };
    expect(validateRemoteFile(expected, { rfilename: "weights", size: 123, lfs: { size: 123, sha256: expected.sha256 } })).toBe(true);
    expect(validateRemoteFile(expected, { rfilename: "config", size: 123 })).toBe(false);
    expect(() => validateRemoteFile(expected, undefined)).toThrow();
    expect(() => validateRemoteFile({ ...expected, sha256: "invalid" }, { rfilename: "config", size: 123 })).toThrow();
    expect(() => validateRemoteFile(expected, { rfilename: "weights", size: 122 })).toThrow();
    expect(() => validateRemoteFile(expected, { rfilename: "weights", size: 123, lfs: { size: 123, sha256: "wrong" } })).toThrow();
  });

  it("uses the exact LS-clean columns, not aggregate scores or another model variant", () => {
    const rows = Object.values(MODEL_EVIDENCE).flatMap(({ reference }) => reference ? [`${reference.modelId},999,${reference.wer},${reference.rtfx}`] : []);
    const csv = ["model,avg,LS Clean WER,LS Clean RTFx", ...rows].join("\n");
    expect(() => validateBenchmarkSnapshot(csv)).not.toThrow();
    expect(() => validateBenchmarkSnapshot(csv.replace("LS Clean WER", "LS Other WER"))).toThrow();
    expect(() => validateBenchmarkSnapshot(csv.replace("1.56", "9.99"))).toThrow();
    expect(() => validateBenchmarkSnapshot(csv.replace("-0.6B-hf", "-0.6B"))).toThrow();
    expect(() => validateBenchmarkSnapshot(`${csv}\n${rows[0]}`)).toThrow();
  });
});
