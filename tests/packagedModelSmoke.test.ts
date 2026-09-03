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

  it("discards noisy worker stderr without exposing controlled content in failures", () => {
    const sentinel = "PRIVATE_WORKER_STDERR_SENTINEL";
    const probe = [
      "import importlib.util, json, os, sys",
      "from pathlib import Path",
      "spec = importlib.util.spec_from_file_location('smoke', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "sys.modules[spec.name] = module",
      "spec.loader.exec_module(module)",
      `child = ${JSON.stringify(`import json, sys\nsys.stderr.write(${JSON.stringify(sentinel)} * (2 * 1024 * 1024 // ${sentinel.length}))\nsys.stderr.flush()\nprint(json.dumps({"type": "hello"}), flush=True)\nsys.exit(7)`)}`,
      "owned = module.start_owned_process([sys.executable, '-u', '-c', child], cwd=Path.cwd(), environment=os.environ.copy())",
      "process = owned.process",
      "stderr = module.WorkerStderrReader(process)",
      "reader = module.WorkerResponseReader(process)",
      "response = reader.receive(timeout_seconds=3)",
      "try:",
      "  module.wait_for_exit(owned)",
      "  failure = 'accepted'",
      "except RuntimeError as error:",
      "  failure = str(error)",
      "finally:",
      "  module.retire_owned_process(owned)",
      "  stderr.join()",
      "print(json.dumps({'type': response['type'], 'failure': failure}))",
    ].join("\n");

    const answer = execFileSync(
      "python3",
      ["-B", "-c", probe, resolve("scripts/smoke-worker.py")],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(answer).not.toContain(sentinel);
    expect(JSON.parse(answer)).toEqual({
      type: "hello",
      failure: "candidate worker exited with code 7",
    });
  });

  it("bounds and rejects simultaneous multi-megabyte import-probe output", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "localscribe-smoke-import-probe-"));
    const sentinel = "PRIVATE_IMPORT_PROBE_SENTINEL";
    try {
      const fakePython = join(temporaryRoot, "fake-python");
      writeFileSync(
        fakePython,
        [
          "#!/usr/bin/env python3",
          "import os, sys, threading",
          "if len(sys.argv) > 4 and 'status_fd = int(sys.argv[1])' in sys.argv[4]:",
          "  os.execv(sys.executable, [sys.executable, *sys.argv[1:]])",
          `chunk = (${JSON.stringify(sentinel)} + 'x' * 8192).encode()`,
          "def flood(descriptor):",
          "  for _ in range(256): os.write(descriptor, chunk)",
          "threads = [threading.Thread(target=flood, args=(descriptor,)) for descriptor in (1, 2)]",
          "for thread in threads: thread.start()",
          "for thread in threads: thread.join()",
        ].join("\n"),
      );
      chmodSync(fakePython, 0o755);
      const probe = [
        "import importlib.util, json, sys",
        "from pathlib import Path",
        "spec = importlib.util.spec_from_file_location('smoke', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "sys.modules[spec.name] = module",
        "spec.loader.exec_module(module)",
        "root = Path(sys.argv[2])",
        "candidate = module.CandidateResources(app=root / 'LocalScribe.app', root=root, python=Path(sys.argv[3]), worker=root, helper=root / 'helper', manifests=root)",
        "try:",
        "  module.assert_packaged_imports(candidate, 'manifest.json', module.worker_environment(role='inference'))",
        "  failure = 'accepted'",
        "except RuntimeError as error:",
        "  failure = str(error)",
        "print(json.dumps({'failure': failure}))",
      ].join("\n");
      const answer = execFileSync(
        "python3",
        ["-B", "-c", probe, resolve("scripts/smoke-worker.py"), temporaryRoot, fakePython],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(answer).not.toContain(sentinel);
      expect(JSON.parse(answer)).toEqual({
        failure: "candidate worker import probe output exceeds its safety limit",
      });
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
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
    expect(smoke).toContain("start_new_session=True");
    expect(smoke).toContain("OWNED_PROCESS_ANCHOR");
    expect(smoke).toContain("retire_owned_process(owned)");
    expect(smoke).toContain("os.killpg(os.getpgrp(), signal.SIGKILL)");
    expect(smoke).not.toContain("os.killpg(process_group_id");
  });

  it("retires a surviving descendant through its live anchor without signaling an unrelated process", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "localscribe-smoke-anchor-"));
    const probe = [
      "import fcntl, importlib.util, json, os, subprocess, sys, time",
      "from pathlib import Path",
      "spec = importlib.util.spec_from_file_location('smoke', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "sys.modules[spec.name] = module",
      "spec.loader.exec_module(module)",
      "root = Path(sys.argv[2])",
      "descendant_code = 'import fcntl, signal, sys, time\\nfrom pathlib import Path\\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\\nwith open(sys.argv[1], \"a+\") as lock:\\n fcntl.flock(lock, fcntl.LOCK_EX)\\n Path(sys.argv[2]).write_text(\"owned\")\\n time.sleep(float(sys.argv[3]))'",
      "child = 'import json, subprocess, sys, time\\nfrom pathlib import Path\\nsubprocess.Popen([sys.executable, \"-c\", sys.argv[3], sys.argv[1], sys.argv[2], sys.argv[4]])\\ndeadline = time.monotonic() + 2\\nwhile not Path(sys.argv[2]).exists() and time.monotonic() < deadline: time.sleep(0.01)\\nprint(json.dumps({\"type\": \"hello\"}), flush=True)'",
      "def lock_available(path):",
      "  handle = path.open('a+')",
      "  try:",
      "    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)",
      "    handle.close()",
      "    return True",
      "  except BlockingIOError:",
      "    handle.close()",
      "    return False",
      "lock = root / 'owned.lock'",
      "marker = root / 'owned.marker'",
      "owned = module.start_owned_process([sys.executable, '-c', child, str(lock), str(marker), descendant_code, '3'], cwd=Path.cwd(), environment=os.environ.copy())",
      "process = owned.process",
      "stderr = module.WorkerStderrReader(process)",
      "reader = module.WorkerResponseReader(process)",
      "reader.receive(timeout_seconds=3)",
      "unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)",
      "try:",
      "  module.wait_for_exit(owned)",
      "  module.retire_owned_process(owned)",
      "  descendant_released = lock_available(lock)",
      "  unexpected_lock = root / 'unexpected.lock'",
      "  unexpected_marker = root / 'unexpected.marker'",
      "  unexpected = module.start_owned_process([sys.executable, '-c', child, str(unexpected_lock), str(unexpected_marker), descendant_code, '1'], cwd=Path.cwd(), environment=os.environ.copy())",
      "  unexpected_stderr = module.WorkerStderrReader(unexpected.process)",
      "  unexpected_reader = module.WorkerResponseReader(unexpected.process)",
      "  unexpected_reader.receive(timeout_seconds=3)",
      "  module.wait_for_exit(unexpected)",
      "  if unexpected.process.poll() is not None: raise RuntimeError('test anchor exited before controlled fault injection')",
      "  unexpected.process.kill()",
      "  unexpected.process.wait(timeout=3)",
      "  orphan_was_alive = not lock_available(unexpected_lock)",
      "  try:",
      "    module.retire_owned_process(unexpected)",
      "    unexpected_failure = 'accepted'",
      "  except RuntimeError as error:",
      "    unexpected_failure = str(error)",
      "  release_deadline = time.monotonic() + 2",
      "  orphan_released = lock_available(unexpected_lock)",
      "  while not orphan_released and time.monotonic() < release_deadline:",
      "    time.sleep(0.02)",
      "    orphan_released = lock_available(unexpected_lock)",
      "  unexpected_stderr.join()",
      "  print(json.dumps({'descendantReleased': descendant_released, 'unrelatedAlive': unrelated.poll() is None, 'anchorExited': process.poll() is not None, 'orphanWasAlive': orphan_was_alive, 'orphanReleasedNaturally': orphan_released, 'unexpectedAnchorFailure': unexpected_failure}))",
      "finally:",
      "  if process.poll() is None: module.retire_owned_process(owned)",
      "  unrelated.terminate()",
      "  unrelated.wait(timeout=3)",
    ].join("\n");

    try {
      const answer = execFileSync(
        "python3",
        ["-B", "-c", probe, resolve("scripts/smoke-worker.py"), temporaryRoot],
        { encoding: "utf8", timeout: 8_000 },
      );
      expect(JSON.parse(answer)).toEqual({
        descendantReleased: true,
        unrelatedAlive: true,
        anchorExited: true,
        orphanWasAlive: true,
        orphanReleasedNaturally: true,
        unexpectedAnchorFailure: "candidate worker ownership anchor exited unexpectedly",
      });
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
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

  it("uses a transient installer role before a fresh offline inference worker", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "localscribe-smoke-roles-"));
    try {
      const app = join(temporaryRoot, "LocalScribe.app");
      const resources = join(app, "Contents", "Resources");
      const python = join(resources, "python-runtime", "venv", "bin", "python3");
      const worker = join(resources, "worker");
      const workerPackage = join(worker, "localscribe_worker");
      const helper = join(resources, "native", "macos", "localscribe-fluidaudio-parakeet");
      const manifests = join(resources, "model-manifest");
      const modelRoot = join(temporaryRoot, "models");
      const audio = join(temporaryRoot, "fixture.wav");
      const roleLog = join(temporaryRoot, "worker-roles.ndjson");
      mkdirSync(join(resources, "python-runtime", "venv", "bin"), { recursive: true });
      mkdirSync(workerPackage, { recursive: true });
      mkdirSync(join(resources, "native", "macos"), { recursive: true });
      mkdirSync(manifests, { recursive: true });
      mkdirSync(modelRoot);
      writeFileSync(python, "#!/bin/sh\nexec /usr/bin/env python3 \"$@\"\n");
      writeFileSync(helper, "#!/bin/sh\nexit 0\n");
      chmodSync(python, 0o755);
      chmodSync(helper, 0o755);
      writeFileSync(join(workerPackage, "__init__.py"), "");
      writeFileSync(
        join(workerPackage, "worker.py"),
        [
          "from pathlib import Path",
          "def _resources(): return Path(__file__).resolve().parents[2]",
          "def _manifest_path(name): return _resources() / 'model-manifest' / name",
          "def _fluid_audio_helper_path(): return _resources() / 'native' / 'macos' / 'localscribe-fluidaudio-parakeet'",
        ].join("\n"),
      );
      writeFileSync(
        join(workerPackage, "__main__.py"),
        [
          "import json, os, sys",
          "from pathlib import Path",
          `log = Path(${JSON.stringify(roleLog)})`,
          "role = os.environ.get('LOCALSCRIBE_WORKER_ROLE')",
          "def send(payload): print(json.dumps(payload), flush=True)",
          "def record(request):",
          "  entry = {'role': role, 'type': request['type'], 'allowDownload': request.get('allowDownload'), 'hfOffline': os.environ.get('HF_HUB_OFFLINE'), 'transformersOffline': os.environ.get('TRANSFORMERS_OFFLINE'), 'uvOffline': os.environ.get('UV_OFFLINE')}",
          "  with log.open('a', encoding='utf-8') as output: output.write(json.dumps(entry) + '\\n')",
          "send({'type': 'hello'})",
          "for line in sys.stdin:",
          "  request = json.loads(line)",
          "  record(request)",
          "  request_id = request['id']",
          "  if request['type'] == 'install_model':",
          "    send({'type': 'model_install_progress', 'id': request_id, 'phase': 'verifying', 'completedBytes': 0, 'totalBytes': 1})",
          "    send({'type': 'model_installed', 'id': request_id})",
          "  elif request['type'] == 'load_model': send({'type': 'model_ready', 'id': request_id})",
          "  elif request['type'] == 'transcribe': send({'type': 'final', 'id': request_id, 'text': 'packaged smoke passed'})",
          "  elif request['type'] == 'shutdown':",
          "    send({'type': 'shutdown', 'id': request_id})",
          "    break",
          "  else: send({'type': 'error', 'id': request_id, 'code': 'unexpected_operation'})",
        ].join("\n"),
      );
      writeFileSync(
        join(manifests, "parakeet-unified-en-0-6b-coreml-int8.json"),
        JSON.stringify({
          platform: "darwin-arm64",
          familyId: "parakeet-unified-en-0-6b",
          modelId: "fixture-model",
        }),
      );
      execFileSync(
        "python3",
        [
          "-c",
          "import sys, wave; w=wave.open(sys.argv[1], 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\\0\\0' * 160); w.close()",
          audio,
        ],
      );

      execFileSync(
        "python3",
        [
          "-B",
          resolve("scripts/smoke-worker.py"),
          "--app",
          app,
          "--model-root",
          modelRoot,
          "--audio",
          audio,
          "--mode",
          "after-stop",
          "--allow-download",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );

      const events = readFileSync(roleLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, string | null>);
      expect(events.map(({ role, type }) => [role, type])).toEqual([
        ["installer", "install_model"],
        ["installer", "shutdown"],
        ["inference", "load_model"],
        ["inference", "transcribe"],
        ["inference", "shutdown"],
      ]);
      expect(events[0]).toMatchObject({
        allowDownload: true,
        hfOffline: null,
        transformersOffline: null,
        uvOffline: null,
      });
      expect(events[2]).toMatchObject({
        allowDownload: false,
        hfOffline: "1",
        transformersOffline: "1",
        uvOffline: "1",
      });
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
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
