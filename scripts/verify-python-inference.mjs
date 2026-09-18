#!/usr/bin/env node

// Run after hardened signing: an unsigned import test cannot detect a native
// dependency which macOS terminates for attempting unsupported JIT allocation.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const application = realpathSync(process.argv[2] ?? "");
if (!application.endsWith(".app")) throw new Error("Expected a candidate .app path");
const resources = realpathSync(path.join(application, "Contents", "Resources"));
if (!resources.startsWith(`${application}${path.sep}`)) throw new Error("Resources escapes candidate application");
const python = realpathSync(path.join(resources, "python-runtime", "venv", "bin", "python3"));
if (!python.startsWith(`${resources}${path.sep}`)) throw new Error("Python escapes candidate resources");
const venvPython = path.join(resources, "python-runtime", "venv", "bin", "python3");
execFileSync(venvPython, [
  "-I", "-B", fileURLToPath(new URL("./prune-mlx-audio-whisper.py", import.meta.url)),
  "--verify", path.join(resources, "python-runtime", "venv", "lib", "python3.12", "site-packages"),
], { timeout: 15_000, stdio: "inherit" });

const probe = String.raw`
import importlib.util
import sys

retired = ("pip", "ensurepip", "mlx_whisper", "numba", "llvmlite", "torch", "tiktoken")
for name in retired:
    if importlib.util.find_spec(name) is not None:
        raise RuntimeError("Retired installer or runtime remains: " + name)

import mlx.core
import localscribe_worker
from mlx_audio.stt import load
from mlx_audio.stt.models.qwen3_asr import Model
from mlx_lm.generate import generate_step
from transformers import AutoTokenizer, WhisperFeatureExtractor

if importlib.util.find_spec("mlx_audio.stt.models.whisper") is not None:
    raise RuntimeError("MLX Audio Whisper backend remains")
if any(name in sys.modules for name in retired):
    raise RuntimeError("Retained runtime imported a removed dependency")
print("Signed Python inference imports verified; retired runtimes absent; no model loaded")
`;

// Use the venv entry point, not its resolved base-interpreter path; -I ignores
// user Python configuration and -B keeps the sealed bundle unchanged.
execFileSync(venvPython, ["-I", "-B", "-c", probe], {
  timeout: 60_000,
  stdio: "inherit",
});
