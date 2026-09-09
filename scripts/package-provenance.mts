import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";
import type { PackagedPlatform } from "../src/shared/platformResourcePolicy";

const PROVENANCE_SCHEMA_VERSION = 1;
const PROVENANCE_DOMAIN = "localscribe-package-provenance-v1";
const PROVENANCE_ARCHIVE_PATH = ".vite/build/package-provenance.json";
const RENDERER_ROOT = ".vite/renderer/main_window";
const BUILD_FRESHNESS_TOLERANCE_MS = 2_000;

const COMMON_RELEASE_INPUTS = [
  ".github/workflows/ci.yml",
  ".githooks/pre-push",
  ".gitignore",
  ".nvmrc",
  ".uv-version",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "eslint.config.mjs",
  "forge.config.ts",
  "index.html",
  "package-lock.json",
  "package.json",
  "scripts/package-inventory.ts",
  "scripts/make-result-safety.mts",
  "scripts/package-provenance.mts",
  "scripts/release-assets.mts",
  "scripts/release-metadata.mjs",
  "scripts/release-metadata.mts",
  "scripts/run-forge-target.mjs",
  "scripts/verify-local-source.mjs",
  "scripts/verify-packaged-archive.mjs",
  "scripts/verify-packaged-main.mjs",
  "scripts/verify-release-assets.mjs",
  /*
   * Source verification executes and typechecks files throughout scripts/, and
   * the test suite is itself release policy. Bind the directories rather than
   * maintaining another fragile copy of package.json's transitive script
   * graph. A new checker or regression test therefore starts affecting the
   * source root immediately, before this list is manually updated.
   */
  "scripts",
  "src",
  "tests",
  "tools/python-audit/pyproject.toml",
  "tools/python-audit/uv.lock",
  "tsconfig.json",
  "vite.main.config.ts",
  "vite.preload.config.ts",
  "vite.renderer.config.ts",
  "vitest.config.ts",
] as const;

const MAC_RELEASE_INPUTS = [
  "resources/audio-protocol.json",
  "resources/branding/LocalScribe.icns",
  "resources/entitlements.mac.active-target.plist",
  "resources/entitlements.mac.helper.plist",
  "resources/entitlements.mac.plist",
  "resources/entitlements.mac.plugin.plist",
  "resources/entitlements.mac.runtime.plist",
  "resources/licenses/FluidAudio-0.15.5-LICENSE.txt",
  "resources/licenses/transcribe-cpp-LICENSE.txt",
  "resources/licenses/transcribe-cpp-ggml-LICENSE.txt",
  "resources/licenses/transcribe-cpp-miniz-LICENSE.txt",
  "resources/model-manifest/canary-qwen-2-5b-gguf-bf16.json",
  "resources/model-manifest/canary-qwen-2-5b-gguf-q8.json",
  "resources/model-manifest/canary-qwen-2-5b-gguf-q4.json",
  "tools/canary-runtime/CMakeLists.txt",
  "tools/canary-runtime/bridge.cpp",
  "tools/canary-runtime/contract-test.cpp",
  "tools/canary-runtime/pin.json",
  "scripts/build-canary-runtime.sh",
  "resources/licenses/FluidAudio-0.15.5-fastcluster-LICENSE.md",
  "resources/licenses/FluidAudio-0.15.5-vbx-LICENSE.md",
  "resources/model-manifest/whisper-large-v2-mlx-4bit.json",
  "resources/model-manifest/whisper-large-v2-mlx-8bit.json",
  "resources/model-manifest/whisper-large-v2-mlx.json",
  "resources/model-manifest/whisper-large-v3-mlx-4bit.json",
  "resources/model-manifest/whisper-large-v3-mlx-8bit.json",
  "resources/model-manifest/whisper-large-v3-mlx.json",
  "resources/model-manifest/qwen3-asr-1-7b-mlx-4bit.json",
  "resources/model-manifest/qwen3-asr-1-7b-mlx-8bit.json",
  "resources/model-manifest/qwen3-asr-1-7b-mlx-bf16.json",
  "resources/model-manifest/qwen3-asr-0-6b-mlx-4bit.json",
  "resources/model-manifest/qwen3-asr-0-6b-mlx-8bit.json",
  "resources/model-manifest/qwen3-asr-0-6b-mlx-bf16.json",
  "resources/model-manifest/parakeet-unified-en-0-6b-coreml-fp16.json",
  "resources/model-manifest/parakeet-unified-en-0-6b-coreml-int8.json",
  "resources/native/macos/active-target.swift",
  "scripts/test-macos-accessibility-target.mjs",
  "scripts/test-settings-scroll-layout.mjs",
  "scripts/settings-layout-harness.html",
  "scripts/settings-layout-harness.tsx",
  "tools/fluidaudio-parakeet-helper/Package.resolved",
  "tools/fluidaudio-parakeet-helper/Package.swift",
  "tools/fluidaudio-parakeet-helper/Sources/localscribe-fluidaudio-parakeet/main.swift",
  /*
   * The macOS gate scripts decide whether an artifact may ship, so a change to
   * one of them has to invalidate the artifact it approved. Without these, a signed app
   * could be re-approved by a weakened checker while still reporting the same
   * source provenance.
   */
  "scripts/build-worker-runtime.sh",
  "scripts/generate-runtime-sbom.mjs",
  "scripts/macos-entitlement-policy.mts",
  "scripts/macos-zip-preflight.mts",
  "scripts/protected-resource-staging.mts",
  "scripts/python-build-standalone.json",
  "scripts/reconcile-python-sbom.py",
  "scripts/smoke-worker.py",
  "scripts/smoke-packaged-macos.sh",
  "scripts/verify-local-macos.sh",
  "scripts/verify-macos-artifacts.mjs",
  "scripts/verify-macos-bundle.mjs",
  "scripts/verify-macos-entitlements.mjs",
  "worker/localscribe_worker",
  "worker/pyproject.toml",
  "worker/tests",
  "worker/uv.lock",
] as const;

const SKIPPED_SOURCE_NAMES = new Set([
  ".DS_Store",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
]);

const ALLOWED_RENDERER_ASSET_EXTENSION =
  /\.(?:css|gif|jpe?g|js|otf|png|svg|ttf|webp|woff2?)$/u;
const WINDOWS_RESERVED_DEVICE_SEGMENT =
  /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_FORBIDDEN_SEGMENT_CHARACTERS = /[<>"|?*]/u;

export interface PackageProvenance {
  schemaVersion: number;
  platform: PackagedPlatform;
  arch: string;
  productName: string;
  version: string;
  sourceRoot: string;
  sourceEntryCount: number;
}

interface SourceEntry {
  relativePath: string;
  size: number;
  contentHash: string;
}

export interface PackageProvenanceOptions {
  projectPath?: string;
  platform: PackagedPlatform;
  arch: string;
  inputCandidates?: readonly string[];
}

export interface ReleaseInputGitOptions {
  projectPath?: string;
  platform: PackagedPlatform;
  inputCandidates?: readonly string[];
}

export interface PackagedArchiveVerificationOptions extends PackageProvenanceOptions {
  asarPath: string;
  expected?: PackageProvenance;
  requireCurrentSource?: boolean;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizedRelativePath(projectPath: string, filePath: string): string {
  return path.relative(projectPath, filePath).split(path.sep).join("/");
}

function shouldSkipSourcePath(filePath: string): boolean {
  const name = path.basename(filePath);
  return SKIPPED_SOURCE_NAMES.has(name) || name.endsWith(".pyc");
}

function collectSourceFiles(projectPath: string, candidate: string, output: string[]): void {
  const absolutePath = path.resolve(projectPath, candidate);
  if (!existsSync(absolutePath)) {
    throw new Error(`Package provenance input is missing: ${candidate}`);
  }
  if (shouldSkipSourcePath(absolutePath)) return;

  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Package provenance rejects source symlinks: ${candidate}`);
  }
  if (stat.isFile()) {
    const relativePath = normalizedRelativePath(projectPath, absolutePath);
    if (relativePath === "src/main/generatedResourceIntegrity.ts") return;
    output.push(absolutePath);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Package provenance rejects unsupported source input: ${candidate}`);
  }
  for (const child of readdirSync(absolutePath).sort(compareCanonical)) {
    collectSourceFiles(projectPath, path.join(candidate, child), output);
  }
}

export function releaseInputCandidates(_platform: PackagedPlatform): readonly string[] {
  return [
    ...COMMON_RELEASE_INPUTS,
    ...MAC_RELEASE_INPUTS,
  ];
}

function sourceEntries(
  projectPath: string,
  platform: PackagedPlatform,
  inputCandidates = releaseInputCandidates(platform),
): SourceEntry[] {
  const files: string[] = [];
  for (const candidate of inputCandidates) {
    collectSourceFiles(projectPath, candidate, files);
  }
  return [...new Set(files)]
    .sort((left, right) =>
      compareCanonical(
        normalizedRelativePath(projectPath, left),
        normalizedRelativePath(projectPath, right),
      )
    )
    .map((filePath) => {
      const content = readFileSync(filePath);
      return {
        relativePath: normalizedRelativePath(projectPath, filePath),
        size: content.length,
        contentHash: sha256(content),
      };
    });
}

/**
 * A release-candidate gate must not approve policy that exists only in one
 * developer's working directory. This deliberately remains opt-in: ordinary
 * pre-commit/package verification is allowed to exercise intended local
 * changes, while the release-candidate mode calls this before building.
 */
export function assertReleaseInputsGitTracked({
  projectPath = process.cwd(),
  platform,
  inputCandidates = releaseInputCandidates(platform),
}: ReleaseInputGitOptions): void {
  const resolvedProjectPath = realpathSync(path.resolve(projectPath));
  const repositoryRoot = execFileSync(
    "git",
    ["-C", resolvedProjectPath, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (path.resolve(repositoryRoot) !== resolvedProjectPath) {
    throw new Error(
      "Release-candidate provenance requires the project path to be the Git repository root.",
    );
  }

  const tracked = new Set(
    execFileSync(
      "git",
      ["-C", resolvedProjectPath, "ls-files", "-z", "--cached", "--"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).split("\0").filter(Boolean),
  );
  const untrackedInputs = sourceEntries(
    resolvedProjectPath,
    platform,
    inputCandidates,
  ).map((entry) => entry.relativePath).filter((entry) => !tracked.has(entry));
  if (untrackedInputs.length > 0) {
    throw new Error(
      `Release-candidate provenance includes ${untrackedInputs.length} untracked input(s); refusing to bless local-only gate policy.`,
    );
  }
}

function packageManifest(projectPath: string): {
  productName: string;
  version: string;
} {
  const manifest = JSON.parse(
    readFileSync(path.join(projectPath, "package.json"), "utf8"),
  ) as { productName?: unknown; version?: unknown };
  if (
    typeof manifest.productName !== "string" ||
    manifest.productName.length === 0 ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0
  ) {
    throw new Error("Package provenance requires package.json productName and version.");
  }
  return { productName: manifest.productName, version: manifest.version };
}

export function buildPackageProvenance({
  projectPath = process.cwd(),
  platform,
  arch,
  inputCandidates,
}: PackageProvenanceOptions): PackageProvenance {
  const resolvedProjectPath = path.resolve(projectPath);
  const entries = sourceEntries(resolvedProjectPath, platform, inputCandidates);
  const manifest = packageManifest(resolvedProjectPath);
  const sourceRoot = sha256([
    PROVENANCE_DOMAIN,
    platform,
    arch,
    ...entries.flatMap((entry) => [
      entry.relativePath,
      String(entry.size),
      entry.contentHash,
    ]),
  ].join("\0"));

  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    platform,
    arch,
    productName: manifest.productName,
    version: manifest.version,
    sourceRoot,
    sourceEntryCount: entries.length,
  };
}

export function writePackageProvenance(
  buildPath: string,
  provenance: PackageProvenance,
): string {
  const outputPath = path.join(buildPath, ...PROVENANCE_ARCHIVE_PATH.split("/"));
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return outputPath;
}

function requiredFreshBuildFiles(buildPath: string): string[] {
  const rendererRoot = path.join(buildPath, ...RENDERER_ROOT.split("/"));
  const assetRoot = path.join(rendererRoot, "assets");
  if (!existsSync(assetRoot)) {
    throw new Error(`Fresh Vite build verification failed: missing ${assetRoot}`);
  }
  const assets = readdirSync(assetRoot)
    .map((entry) => path.join(assetRoot, entry))
    .filter((entry) => statSync(entry).isFile());
  if (assets.length === 0) {
    throw new Error("Fresh Vite build verification failed: renderer emitted no assets.");
  }
  return [
    path.join(buildPath, ".vite", "build", "main.js"),
    path.join(buildPath, ".vite", "build", "preload.js"),
    path.join(rendererRoot, "index.html"),
    ...assets,
  ];
}

export function assertFreshViteBuild(buildPath: string, buildStartedAtMs: number): void {
  for (const filePath of requiredFreshBuildFiles(buildPath)) {
    if (!existsSync(filePath)) {
      throw new Error(`Fresh Vite build verification failed: missing ${filePath}`);
    }
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`Fresh Vite build verification failed: empty output ${filePath}`);
    }
    if (stat.mtimeMs + BUILD_FRESHNESS_TOLERANCE_MS < buildStartedAtMs) {
      throw new Error(
        `Fresh Vite build verification failed: stale output ${filePath} predates this package invocation.`,
      );
    }
  }
}

export function normalizeArchiveEntry(entry: string): string {
  const rootSeparator = entry[0];
  if (rootSeparator !== "/" && rootSeparator !== "\\") {
    throw new Error(
      `Packaged archive verification failed: archive entry has no canonical root separator: ${JSON.stringify(entry)}.`,
    );
  }

  const relativePath = entry.slice(1);
  const alternateSeparator = rootSeparator === "/" ? "\\" : "/";
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    relativePath.includes(alternateSeparator) ||
    hasControlCharacter(relativePath) ||
    relativePath.includes(":")
  ) {
    throw new Error(
      `Packaged archive verification failed: archive entry has an ambiguous path: ${JSON.stringify(entry)}.`,
    );
  }

  const segments = relativePath.split(rootSeparator);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(
      `Packaged archive verification failed: archive entry has an unsafe path: ${JSON.stringify(entry)}.`,
    );
  }
  return segments.join("/");
}

function windowsArchiveKey(normalizedEntry: string): string {
  for (const segment of normalizedEntry.split("/")) {
    if (
      segment.endsWith(".")
      || segment.endsWith(" ")
      || WINDOWS_FORBIDDEN_SEGMENT_CHARACTERS.test(segment)
      || WINDOWS_RESERVED_DEVICE_SEGMENT.test(segment)
    ) {
      throw new Error(
        `Packaged archive verification failed: archive entry is not a portable Windows path: ${JSON.stringify(normalizedEntry)}.`,
      );
    }
  }
  return normalizedEntry.toLocaleLowerCase("en-US");
}

export function normalizeArchiveEntries(
  entries: readonly string[],
  _platform: PackagedPlatform,
): Set<string> {
  const normalizedEntries = new Set<string>();
  const windowsEntries = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeArchiveEntry(entry);
    if (normalizedEntries.has(normalized)) {
      throw new Error(
        `Packaged archive verification failed: archive contains duplicate canonical path ${normalized}.`,
      );
    }
    const windowsKey = windowsArchiveKey(normalized);
    if (windowsEntries.has(windowsKey)) {
      throw new Error(
        `Packaged archive verification failed: archive contains a case-insensitive portable-path collision at ${normalized}.`,
      );
    }
    windowsEntries.add(windowsKey);
    normalizedEntries.add(normalized);
  }
  return normalizedEntries;
}

function archiveEntries(asarPath: string, platform: PackagedPlatform): Set<string> {
  return normalizeArchiveEntries(listPackage(asarPath, { isPack: false }), platform);
}

export function archiveExtractionPath(
  canonicalArchivePath: string,
  separator = path.sep,
): string {
  if (
    (separator !== "/" && separator !== "\\")
    || canonicalArchivePath.length === 0
    || canonicalArchivePath.startsWith("/")
    || canonicalArchivePath.includes("\\")
    || canonicalArchivePath.split("/").some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `Packaged archive verification failed: invalid canonical extraction path ${JSON.stringify(canonicalArchivePath)}.`,
    );
  }
  return canonicalArchivePath.split("/").join(separator);
}

function extractArchiveText(asarPath: string, archivePath: string): string {
  let content: Buffer;
  try {
    content = extractFile(asarPath, archiveExtractionPath(archivePath));
  } catch (error) {
    throw new Error(
      `Packaged archive verification failed: could not extract ${archivePath}`,
      { cause: error },
    );
  }
  if (content.length === 0) {
    throw new Error(`Packaged archive verification failed: empty ${archivePath}`);
  }
  return content.toString("utf8");
}

function parseProvenance(source: string): PackageProvenance {
  const parsed = JSON.parse(source) as Partial<PackageProvenance>;
  if (
    parsed.schemaVersion !== PROVENANCE_SCHEMA_VERSION ||
    parsed.platform !== "darwin" ||
    typeof parsed.arch !== "string" ||
    typeof parsed.productName !== "string" ||
    typeof parsed.version !== "string" ||
    !/^[a-f0-9]{64}$/u.test(parsed.sourceRoot ?? "") ||
    !Number.isSafeInteger(parsed.sourceEntryCount) ||
    (parsed.sourceEntryCount ?? 0) <= 0
  ) {
    throw new Error("Packaged archive verification failed: malformed package provenance.");
  }
  return parsed as PackageProvenance;
}

export function assertPackageProvenanceMatches(
  actual: PackageProvenance,
  expected: PackageProvenance,
): void {
  for (const key of [
    "schemaVersion",
    "platform",
    "arch",
    "productName",
    "version",
    "sourceRoot",
    "sourceEntryCount",
  ] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `Packaged archive verification failed: provenance ${key} is ${JSON.stringify(actual[key])}, expected ${JSON.stringify(expected[key])}.`,
      );
    }
  }
}

function resolveRendererReference(
  reference: string,
  baseDirectory = RENDERER_ROOT,
): string {
  if (
    reference.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(reference) ||
    reference.startsWith("//")
  ) {
    throw new Error(
      `Packaged archive verification failed: renderer has non-local asset reference ${reference}.`,
    );
  }
  const cleanReference = reference.split(/[?#]/u, 1)[0] ?? "";
  const resolved = path.posix.normalize(path.posix.join(baseDirectory, cleanReference));
  if (!resolved.startsWith(`${RENDERER_ROOT}/`)) {
    throw new Error(
      `Packaged archive verification failed: renderer asset escapes its root: ${reference}.`,
    );
  }
  return resolved;
}

function assertRendererArchive(asarPath: string, entries: ReadonlySet<string>): void {
  const indexPath = `${RENDERER_ROOT}/index.html`;
  const index = extractArchiveText(asarPath, indexPath);
  const references = [
    ...index.matchAll(/<(?:link|script)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/giu),
  ].map((match) => match[1]).filter((entry): entry is string => Boolean(entry));
  if (!references.some((entry) => entry.endsWith(".js"))) {
    throw new Error("Packaged archive verification failed: renderer has no JavaScript entry.");
  }
  if (!references.some((entry) => entry.endsWith(".css"))) {
    throw new Error("Packaged archive verification failed: renderer has no stylesheet entry.");
  }
  for (const reference of references) {
    const resolved = resolveRendererReference(reference);
    if (!entries.has(resolved)) {
      throw new Error(
        `Packaged archive verification failed: renderer references missing asset ${resolved}.`,
      );
    }
    extractArchiveText(asarPath, resolved);
  }

  const rendererAssets = [...entries].filter((entry) =>
    entry.startsWith(`${RENDERER_ROOT}/assets/`) &&
    !entry.endsWith("/")
  );
  if (rendererAssets.length === 0) {
    throw new Error("Packaged archive verification failed: renderer asset directory is empty.");
  }
  for (const asset of rendererAssets) {
    if (asset.endsWith(".map") || !ALLOWED_RENDERER_ASSET_EXTENSION.test(asset)) {
      throw new Error(
        `Packaged archive verification failed: unexpected renderer artifact ${asset}.`,
      );
    }
    extractArchiveText(asarPath, asset);
  }

  const stylesheets = rendererAssets.filter((entry) => entry.endsWith(".css"));
  for (const stylesheet of stylesheets) {
    const source = extractArchiveText(asarPath, stylesheet);
    for (const match of source.matchAll(
      /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)"']+))\s*\)/giu,
    )) {
      const reference = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (
        reference.length === 0 ||
        reference.startsWith("#") ||
        /^(?:data|blob):/iu.test(reference)
      ) {
        continue;
      }
      const resolved = resolveRendererReference(
        reference,
        path.posix.dirname(stylesheet),
      );
      if (!entries.has(resolved)) {
        throw new Error(
          `Packaged archive verification failed: renderer stylesheet references missing asset ${resolved}.`,
        );
      }
      extractArchiveText(asarPath, resolved);
    }
  }

  const scripts = rendererAssets.filter((entry) => entry.endsWith(".js"));
  const referencedAssets = new Set<string>();
  for (const script of scripts) {
    const source = extractArchiveText(asarPath, script);
    for (const match of source.matchAll(/assets\/[A-Za-z0-9._-]+/gu)) {
      referencedAssets.add(`${RENDERER_ROOT}/${match[0]}`);
    }
  }
  for (const referencedAsset of referencedAssets) {
    if (!entries.has(referencedAsset)) {
      throw new Error(
        `Packaged archive verification failed: renderer JavaScript references missing asset ${referencedAsset}.`,
      );
    }
  }
}

export function assertPackagedArchive({
  asarPath,
  projectPath = process.cwd(),
  platform,
  arch,
  expected,
  requireCurrentSource = true,
  inputCandidates,
}: PackagedArchiveVerificationOptions): PackageProvenance {
  const resolvedAsarPath = path.resolve(asarPath);
  if (!existsSync(resolvedAsarPath)) {
    throw new Error(`Packaged archive verification failed: missing ${resolvedAsarPath}`);
  }

  const entries = archiveEntries(resolvedAsarPath, platform);
  for (const required of [
    ".vite/build/main.js",
    ".vite/build/preload.js",
    PROVENANCE_ARCHIVE_PATH,
    `${RENDERER_ROOT}/index.html`,
    "package.json",
  ]) {
    if (!entries.has(required)) {
      throw new Error(`Packaged archive verification failed: missing ${required}`);
    }
  }
  if ([...entries].some((entry) => entry.endsWith(".map"))) {
    throw new Error("Packaged archive verification failed: source map present in app.asar.");
  }
  extractArchiveText(resolvedAsarPath, ".vite/build/main.js");
  extractArchiveText(resolvedAsarPath, ".vite/build/preload.js");
  assertRendererArchive(resolvedAsarPath, entries);

  const manifest = JSON.parse(
    extractArchiveText(resolvedAsarPath, "package.json"),
  ) as { main?: unknown; productName?: unknown; version?: unknown };
  const sourceManifest = packageManifest(path.resolve(projectPath));
  if (
    manifest.main !== ".vite/build/main.js" ||
    manifest.productName !== sourceManifest.productName ||
    manifest.version !== sourceManifest.version
  ) {
    throw new Error("Packaged archive verification failed: package identity or main entry drifted.");
  }

  const actual = parseProvenance(
    extractArchiveText(resolvedAsarPath, PROVENANCE_ARCHIVE_PATH),
  );
  if (actual.platform !== platform || actual.arch !== arch) {
    throw new Error(
      `Packaged archive verification failed: artifact targets ${actual.platform}/${actual.arch}, expected ${platform}/${arch}.`,
    );
  }
  if (expected) assertPackageProvenanceMatches(actual, expected);
  if (requireCurrentSource) {
    assertPackageProvenanceMatches(
      actual,
      buildPackageProvenance({ projectPath, platform, arch, inputCandidates }),
    );
  }
  return actual;
}

export const packageProvenanceArchivePath = PROVENANCE_ARCHIVE_PATH;
