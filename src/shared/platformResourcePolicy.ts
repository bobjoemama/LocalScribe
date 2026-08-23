import { RELEASE_POLICY } from "./releasePolicy.mts";

export type PackagedPlatform = "darwin";

export interface PlatformResourcePolicy {
  platform: PackagedPlatform;
  arch: "arm64";
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
  "qwen3-asr-1-7b-mlx-bf16.json",
  "qwen3-asr-1-7b-mlx-8bit.json",
  "qwen3-asr-1-7b-mlx-4bit.json",
  "qwen3-asr-0-6b-mlx-bf16.json",
  "qwen3-asr-0-6b-mlx-8bit.json",
  "qwen3-asr-0-6b-mlx-4bit.json",
  "parakeet-unified-en-0-6b-coreml-fp16.json",
  "parakeet-unified-en-0-6b-coreml-int8.json",
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
  if (platform === "darwin" && arch === RELEASE_POLICY.targets.darwin.arch) {
    return {
      platform,
      arch,
      workerDirectory: "worker/localscribe_worker",
      runtimeDirectory: "python-runtime",
      runtimeExecutable: "python-runtime/venv/bin/python3",
      helperFiles: [
        "native/macos/active-target",
        "native/macos/localscribe-fluidaudio-parakeet",
      ],
      manifestFiles: MAC_MANIFESTS.map((filename) => `model-manifest/${filename}`),
      brandingFiles: [],
    };
  }
  throw new Error(`LocalScribe has no release resource policy for ${platform}/${arch}`);
}
