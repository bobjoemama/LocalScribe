/** Online metadata audit. No model weights, tokens, caches, or installs. */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_EVIDENCE, REFERENCE_BENCHMARK_URL, modelArtifactSourceUrl } from "../src/shared/modelEvidence.ts";
import type { ModelFamilyId } from "../src/shared/contracts.ts";

interface Manifest {
  familyId: ModelFamilyId;
  modelId: string;
  revision: string;
  files: Record<string, { bytes: number; sha256: string }>;
}
interface HubMetadata {
  id: string;
  sha: string;
  siblings: { rfilename: string; size: number; lfs?: { sha256: string; size: number } }[];
}

export function validateSourceIdentity(manifest: Manifest, metadata: HubMetadata): void {
  const evidence = MODEL_EVIDENCE[manifest.familyId];
  if (!evidence || !modelArtifactSourceUrl(manifest.modelId, manifest.revision)
    || manifest.modelId.split("/")[0] !== evidence.artifactPublisher
    || metadata.id !== manifest.modelId || metadata.sha !== manifest.revision) {
    throw new Error(`Model publisher/revision mismatch: ${manifest.modelId}`);
  }
}

export function validateRemoteFile(expected: Manifest["files"][string], remote: HubMetadata["siblings"][number] | undefined): boolean {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new Error("Invalid manifest file size or digest");
  }
  if (!remote || remote.size !== expected.bytes) throw new Error("Remote file missing or byte count differs");
  if (remote.lfs) {
    if (remote.lfs.sha256 !== expected.sha256 || remote.lfs.size !== expected.bytes) throw new Error("Remote SHA-256 differs");
    return true;
  }
  return false; // Small Git blobs need their contents hashed; a Git OID is not SHA-256.
}

async function readBounded(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${url}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Metadata size limit exceeded: ${url}`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

async function audit() {
  const root = fileURLToPath(new URL("../resources/model-manifest/", import.meta.url));
  const metadataCache = new Map<string, HubMetadata>();
  const blobCache = new Map<string, Buffer>();
  let files = 0;
  let manifests = 0;
  for (const name of (await readdir(root)).filter((name) => name.endsWith(".json")).sort()) {
    const manifest = JSON.parse(await readFile(path.join(root, name), "utf8")) as Manifest;
    if (!modelArtifactSourceUrl(manifest.modelId, manifest.revision)) throw new Error(`Unapproved source in ${name}`);
    const identity = `${manifest.modelId}/revision/${manifest.revision}`;
    let metadata = metadataCache.get(identity);
    if (!metadata) {
      metadata = JSON.parse((await readBounded(`https://huggingface.co/api/models/${identity}?blobs=true`, 4_000_000)).toString()) as HubMetadata;
      metadataCache.set(identity, metadata);
    }
    validateSourceIdentity(manifest, metadata);
    for (const [filename, expected] of Object.entries(manifest.files)) {
      const remote = metadata.siblings.find((file) => file.rfilename === filename);
      if (!validateRemoteFile(expected, remote)) {
        // Never retrieve an unrecognized binary or weight file, even if small.
        if (!(filename === ".gitattributes" || filename === "README.md" || /\.(json|txt|plist|mil|mlmodel)$/.test(filename)) || expected.bytes > 4_000_000) {
          throw new Error(`Cannot verify ${filename} without a model download`);
        }
        const encodedPath = filename.split("/").map(encodeURIComponent).join("/");
        const url = `https://huggingface.co/${manifest.modelId}/raw/${manifest.revision}/${encodedPath}`;
        let blob = blobCache.get(url);
        if (!blob) {
          blob = await readBounded(url, expected.bytes);
          blobCache.set(url, blob);
        }
        if (blob.length !== expected.bytes || createHash("sha256").update(blob).digest("hex") !== expected.sha256) {
          throw new Error(`Git blob SHA-256 differs: ${filename}`);
        }
      }
      files++;
    }
    manifests++;
    console.log(`PASS ${name}: canonical publisher, pinned revision, file sizes and SHA-256`);
  }
  console.log(`Verified ${manifests} manifests / ${files} file entries; no model weights downloaded.`);
  for (const evidence of Object.values(MODEL_EVIDENCE)) {
    const metadata = JSON.parse((await readBounded(`https://huggingface.co/api/models/${evidence.originalModelId}`, 4_000_000)).toString()) as { id: string };
    if (metadata.id !== evidence.originalModelId) throw new Error(`Original model link mismatch: ${evidence.originalModelId}`);
  }
  const csv = (await readBounded(REFERENCE_BENCHMARK_URL.replace("/blob/", "/raw/"), 1_000_000)).toString();
  validateBenchmarkSnapshot(csv);
  console.log("Original model links and pinned benchmark values verified.");
}

export function validateBenchmarkSnapshot(csv: string): void {
  // Only these numeric columns/IDs are read; quoted descriptions are ignored.
  // Reject quoted CSV rather than risk silently parsing a changed format wrong.
  const rows = csv.trim().split(/\r?\n/);
  const header = rows.shift()?.split(",") ?? [];
  const werIndex = header.indexOf("LS Clean WER");
  const speedIndex = header.indexOf("LS Clean RTFx");
  if (header[0] !== "model" || werIndex < 1 || speedIndex < 1) throw new Error("Benchmark columns changed");
  for (const evidence of Object.values(MODEL_EVIDENCE)) {
    if (!evidence.reference) continue;
    const reference = evidence.reference;
    const matches = rows.filter((row) => row.startsWith(`${reference.modelId},`));
    if (matches.length !== 1 || matches[0]!.includes('"')) throw new Error(`Missing or ambiguous benchmark row: ${reference.modelId}`);
    const cells = matches[0]!.split(",");
    if (cells[werIndex]?.trim() === "" || cells[speedIndex]?.trim() === ""
      || Number(cells[werIndex]) !== reference.wer || Number(cells[speedIndex]) !== reference.rtfx) {
      throw new Error(`Benchmark values differ: ${reference.modelId}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await audit();
}
