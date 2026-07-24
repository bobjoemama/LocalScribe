export type PackagedPlatform = "darwin" | "win32";

export interface PlatformResourcePolicy {
  platform: PackagedPlatform;
  arch: "arm64" | "x64";
  workerDirectory: string;
  runtimeDirectory: string;
  runtimeExecutable: string;
  helperFiles: readonly string[];
  manifestFiles: readonly string[];
  brandingFiles: readonly string[];
}

const MAC_MANIFESTS = [
  "whisper-large-v3-mlx.json",
  "whisper-large-v3-mlx-8bit.json",
  "whisper-large-v3-mlx-4bit.json",
  "whisper-large-v2-mlx.json",
  "whisper-large-v2-mlx-8bit.json",
  "whisper-large-v2-mlx-4bit.json",
] as const;

const WINDOWS_MANIFESTS = [
  "faster-whisper-large-v3.json",
  "faster-whisper-large-v2.json",
] as const;

const FORBIDDEN_PACKAGED_RESOURCE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i,
  /(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache)(?:\/|$)/i,
  /(?:^|\/)(?:CACHEDIR\.TAG|\.DS_Store|Thumbs\.db)$/i,
  /(?:^|\/)(?:package-lock\.json|uv\.lock|pyproject\.toml)$/i,
  /(?:^|\/)\.env(?:\.[^/]*)?$/i,
  /(?:^|\/)(?:secrets?|credentials?)(?:\/|$)/i,
  /(?:^|\/)[^/]*(?:private[-_.]?key|client[-_.]?secret)[^/]*$/i,
  /(?:^|\/)(?:weights\.npz|model\.bin|model\.safetensors)$/i,
  /\.(?:map|py[co]|p12|pfx|mobileprovision)$/i,
  /\.(?:swift|c|cc|cpp|cxx|h|hpp|ps1|bat|cmd|sh)$/i,
];

function normalizeEntry(entry: string): string {
  return entry.replaceAll("\\", "/").replace(/^\/+/, "");
}

/** Paths which the release packager removes from copied worker/runtime trees. */
export function isForbiddenPackagedResourcePath(entry: string): boolean {
  const normalized = normalizeEntry(entry);
  return FORBIDDEN_PACKAGED_RESOURCE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function resourcePolicyFor(
  platform: PackagedPlatform,
  arch: string,
): PlatformResourcePolicy {
  if (platform === "darwin" && arch === "arm64") {
    return {
      platform,
      arch,
      workerDirectory: "worker/localscribe_worker",
      runtimeDirectory: "python-runtime",
      runtimeExecutable: "python-runtime/venv/bin/python3",
      helperFiles: ["native/macos/active-target"],
      manifestFiles: MAC_MANIFESTS.map((filename) => `model-manifest/${filename}`),
      brandingFiles: [],
    };
  }
  if (platform === "win32" && arch === "x64") {
    return {
      platform,
      arch,
      workerDirectory: "worker/windows_transformers/localscribe_windows_worker",
      runtimeDirectory: "python-runtime-windows",
      runtimeExecutable: "python-runtime-windows/venv/Scripts/python.exe",
      helperFiles: ["native/windows/active-target.exe"],
      manifestFiles: WINDOWS_MANIFESTS.map((filename) => `model-manifest/${filename}`),
      brandingFiles: ["branding/LocalScribe.ico"],
    };
  }
  throw new Error(`LocalScribe has no release resource policy for ${platform}/${arch}`);
}
