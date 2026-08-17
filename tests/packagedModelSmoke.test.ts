import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const projectFile = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

describe("packaged macOS real-model smoke", () => {
  it("resolves a self-contained candidate bundle without consulting the source tree", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "localscribe-packaged-smoke-"));
    try {
      const resources = join(temporaryRoot, "LocalScribe.app", "Contents", "Resources");
      const python = join(resources, "python-runtime", "venv", "bin", "python3");
      const worker = join(resources, "worker");
      const helper = join(resources, "native", "macos", "localscribe-fluidaudio-parakeet");
      const manifests = join(resources, "model-manifest");
      mkdirSync(join(worker, "localscribe_worker"), { recursive: true });
      mkdirSync(manifests, { recursive: true });
      mkdirSync(join(resources, "python-runtime", "venv", "bin"), { recursive: true });
      mkdirSync(join(resources, "native", "macos"), { recursive: true });
      writeFileSync(python, "#!/bin/sh\nexit 0\n");
      writeFileSync(helper, "#!/bin/sh\nexit 0\n");
      chmodSync(python, 0o755);
      chmodSync(helper, 0o755);

      const answer = execFileSync(
        "python3",
        [
          "-B",
          "-c",
          [
            "import importlib.util, json, sys",
            "spec = importlib.util.spec_from_file_location('smoke', sys.argv[1])",
            "module = importlib.util.module_from_spec(spec)",
            "sys.modules[spec.name] = module",
            "spec.loader.exec_module(module)",
            "candidate = module.candidate_resources(sys.argv[2])",
            "print(json.dumps({'python': str(candidate.python), 'worker': str(candidate.worker), 'helper': str(candidate.helper), 'manifests': str(candidate.manifests)}))",
          ].join("\n"),
          resolve("scripts/smoke-worker.py"),
          join(temporaryRoot, "LocalScribe.app"),
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(answer)).toEqual({
        python: realpathSync(python),
        worker: realpathSync(worker),
        helper: realpathSync(helper),
        manifests: realpathSync(manifests),
      });
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("consumes only bounded, correlated install progress before the terminal result", () => {
    const workerProgram = [
      "import json, sys",
      "for line in sys.stdin:",
      "  request = json.loads(line)",
      "  request_id = request['id']",
      "  if request.get('bad'):",
      "    replies = [('model_install_progress', 'verifying', 0, 10), ('model_install_progress', 'verifying', 8, 10), ('model_install_progress', 'verifying', 7, 10)]",
      "  elif request['type'] == 'install_model':",
      "    replies = [('model_install_progress', 'verifying', 0, 10), ('model_install_progress', 'downloading', 0, 10), ('model_install_progress', 'downloading', 10, 10), ('model_install_progress', 'verifying', 0, 10), ('model_install_progress', 'verifying', 10, 10), ('model_installed', None, None, None)]",
      "  else:",
      "    replies = [('model_install_progress', 'verifying', 0, 10)]",
      "  for type_, phase, completed, total in replies:",
      "    response = {'type': type_, 'id': request_id}",
      "    if phase is not None: response.update({'phase': phase, 'completedBytes': completed, 'totalBytes': total})",
      "    print(json.dumps(response), flush=True)",
    ].join("\n");
    const probe = [
      "import importlib.util, json, subprocess, sys",
      "spec = importlib.util.spec_from_file_location('smoke', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "sys.modules[spec.name] = module",
      "spec.loader.exec_module(module)",
      `child = ${JSON.stringify(workerProgram)}`,
      "process = subprocess.Popen([sys.executable, '-u', '-c', child], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
      "reader = module.WorkerResponseReader(process)",
      "try:",
      "  installed = module.request(process, reader, {'type': 'install_model'}, timeout_seconds=1)",
      "  try:",
      "    module.request(process, reader, {'type': 'load_model'}, timeout_seconds=1)",
      "    unexpected_progress = 'accepted'",
      "  except RuntimeError as error:",
      "    unexpected_progress = str(error)",
      "  try:",
      "    module.request(process, reader, {'type': 'install_model', 'bad': True}, timeout_seconds=1)",
      "    non_monotonic = 'accepted'",
      "  except RuntimeError as error:",
      "    non_monotonic = str(error)",
      "  print(json.dumps({'terminal': installed['type'], 'unexpectedProgress': unexpected_progress, 'nonMonotonic': non_monotonic}))",
      "finally:",
      "  process.terminate()",
      "  process.wait(timeout=1)",
    ].join("\n");

    const answer = execFileSync(
      "python3",
      ["-B", "-c", probe, resolve("scripts/smoke-worker.py")],
      { encoding: "utf8" },
    );
    expect(JSON.parse(answer)).toEqual({
      terminal: "model_installed",
      unexpectedProgress: "candidate worker sent install progress for a non-install request",
      nonMonotonic: "candidate install progress is not monotonic",
    });
  });

  it("starts only the candidate bundle's interpreter, worker, helper, and manifests", () => {
    const smoke = projectFile("scripts/smoke-worker.py");

    expect(smoke).toContain('parser.add_argument(\n        "--app",');
    expect(smoke).not.toContain('parser.add_argument("--python"');
    expect(smoke).not.toContain('parser.add_argument("--worker"');
    expect(smoke).toContain('app / "Contents" / "Resources"');
    expect(smoke).toContain('resources / "python-runtime" / "venv" / "bin" / "python3"');
    expect(smoke).toContain('resources / "worker"');
    expect(smoke).toContain('resources / "native" / "macos" / "localscribe-fluidaudio-parakeet"');
    expect(smoke).toContain('resources / "model-manifest"');
    expect(smoke).toContain('cwd=candidate.worker');
    expect(smoke).toContain('[str(candidate.python), "-B", "-E", "-m", "localscribe_worker"]');
    expect(smoke).toContain("assert_packaged_imports(candidate, manifest_filename, environment)");
    expect(smoke).toContain("candidate worker resolved a source-tree or unexpected resource");
    expect(smoke).toContain("MAX_SMOKE_AUDIO_SECONDS: Final = 120");
    expect(smoke).toContain("candidate {mode} smoke returned an empty final transcript");
  });

  it("is offline and read-only by default, while making download opt-in explicit", () => {
    const smoke = projectFile("scripts/smoke-worker.py");
    const verification = projectFile("scripts/verify-local-macos.sh");

    expect(smoke).toContain('environment["HF_HUB_OFFLINE"] = "1"');
    expect(smoke).toContain('"allowDownload": False');
    expect(smoke).toContain("assert_model_root_is_read_only(model_root, allow_download=args.allow_download)");
    expect(smoke).toContain('MODEL_TRANSACTION_PREFIX: Final = ".localscribe-model-install-"');
    expect(smoke).toContain('parser.add_argument(\n        "--allow-download",');
    expect(verification).toContain("--smoke-allow-download");
    expect(verification).toContain('smoke_arguments+=(--allow-download)');
    expect(verification).toContain('candidate_python="$app_path/Contents/Resources/python-runtime/venv/bin/python3"');
    expect(verification).toContain('--app "$app_path"');
    expect(verification).toContain('"$candidate_python" -B scripts/smoke-worker.py');
    expect(verification).not.toContain("--python resources/python-runtime/venv/bin/python3");
    expect(verification).not.toContain("--worker worker");
  });

  it("makes the default-model acceptance path cover both Parakeet modes", () => {
    const smoke = projectFile("scripts/smoke-worker.py");
    const verification = projectFile("scripts/verify-local-macos.sh");

    expect(smoke).toContain('default=PARAKEET_FAMILY');
    expect(smoke).toContain('choices=("after-stop", "live", "both")');
    expect(smoke).toContain('default="both"');
    expect(smoke).toContain('modes = ("after-stop", "live") if args.mode == "both" else (args.mode,)');
    expect(verification).toContain('smoke_family="parakeet-unified-en-0-6b"');
    expect(verification).toContain('smoke_mode="both"');
  });
});
