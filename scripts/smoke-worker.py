#!/usr/bin/env python3
"""Exercise a real model through a freshly packaged macOS app's resources.

This is deliberately a protocol-level smoke rather than an Electron UI test:
it starts only the Python worker that is copied into the candidate app.  That
keeps an external model root read-only by default while proving that the
candidate's interpreter, worker sources, model manifests, and FluidAudio helper
can cooperate.  ``--allow-download`` is the sole opt-in path that may mutate
the supplied model root.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import select
import signal
import stat
import subprocess
import threading
import time
import uuid
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO, Final

MACOS_FAMILY_TIER_MANIFESTS: Final = {
    "parakeet-unified-en-0-6b": {
        "high": ("parakeet-unified-en-0-6b-coreml-fp16.json", "coreml-fp16"),
        "medium": (
            "parakeet-unified-en-0-6b-coreml-int8.json",
            "coreml-int8",
        ),
    },
    "qwen3-asr-1-7b": {
        "high": ("qwen3-asr-1-7b-mlx-bf16.json", "bfloat16"),
        "medium": ("qwen3-asr-1-7b-mlx-8bit.json", "int8"),
        "low": ("qwen3-asr-1-7b-mlx-4bit.json", "int4"),
    },
    "qwen3-asr-0-6b": {
        "high": ("qwen3-asr-0-6b-mlx-bf16.json", "bfloat16"),
        "medium": ("qwen3-asr-0-6b-mlx-8bit.json", "int8"),
        "low": ("qwen3-asr-0-6b-mlx-4bit.json", "int4"),
    },
}
PARAKEET_FAMILY: Final = "parakeet-unified-en-0-6b"
MODEL_TRANSACTION_PREFIX: Final = ".localscribe-model-install-"
MAX_SMOKE_AUDIO_SECONDS: Final = 120
MAX_SMOKE_AUDIO_BYTES: Final = 16_000 * 2 * MAX_SMOKE_AUDIO_SECONDS
MAX_PROTOCOL_INTEGER: Final = 2**53 - 1
MAX_INSTALL_PROGRESS_EVENTS: Final = 1_000_000
MAX_WORKER_RESPONSE_BYTES: Final = 1024 * 1024
MAX_IMPORT_PROBE_OUTPUT_BYTES: Final = 64 * 1024
WORKER_REQUEST_TIMEOUT_SECONDS: Final = 20 * 60
WORKER_SHUTDOWN_TIMEOUT_SECONDS: Final = 5
PROCESS_GROUP_POLL_SECONDS: Final = 0.05
OWNED_PROCESS_ANCHOR: Final = r"""
import os
import select
import signal
import sys

status_fd = int(sys.argv[1])
control_fd = int(sys.argv[2])
command = sys.argv[3:]
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = os.fork()
if child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    os.close(status_fd)
    os.close(control_fd)
    os.execv(command[0], command)

for descriptor in (0, 1, 2):
    try:
        os.close(descriptor)
    except OSError:
        pass

reported = False
while True:
    if not reported:
        finished, wait_status = os.waitpid(child, os.WNOHANG)
        if finished:
            exit_code = os.waitstatus_to_exitcode(wait_status)
            try:
                os.write(status_fd, (str(exit_code) + "\n").encode("ascii"))
            except OSError:
                pass
            os.close(status_fd)
            reported = True
    ready, _, _ = select.select([control_fd], [], [], 0.05)
    if not ready:
        continue
    command_byte = os.read(control_fd, 1)
    if command_byte == b"T":
        os.killpg(os.getpgrp(), signal.SIGTERM)
    elif command_byte == b"K" or not command_byte:
        os.killpg(os.getpgrp(), signal.SIGKILL)
"""


@dataclass(frozen=True)
class CandidateResources:
    app: Path
    root: Path
    python: Path
    worker: Path
    helper: Path
    manifests: Path


@dataclass
class OwnedProcess:
    """A worker whose live session anchor owns every group-wide signal."""

    process: subprocess.Popen[bytes]
    status_fd: int
    control_fd: int
    status_pending: bytearray = field(default_factory=bytearray)
    worker_exit_code: int | None = None
    retired: bool = False


@dataclass
class InstallProgressState:
    total_bytes: int | None = None
    phase: str | None = None
    completed_bytes: int = 0
    events: int = 0
    saw_download: bool = False
    saw_post_download_verification: bool = False


@dataclass
class WorkerStderrReader:
    """Drain worker-controlled stderr without retaining or decoding its content."""

    process: subprocess.Popen[bytes]
    _thread: threading.Thread = field(init=False)

    def __post_init__(self) -> None:
        if self.process.stderr is None:
            raise RuntimeError("candidate worker stderr is unavailable")
        self._thread = threading.Thread(
            target=self._drain,
            name="localscribe-smoke-stderr",
            daemon=True,
        )
        self._thread.start()

    def _drain(self) -> None:
        if self.process.stderr is None:
            return
        while True:
            try:
                chunk = os.read(self.process.stderr.fileno(), 64 * 1024)
            except OSError:
                return
            if not chunk:
                return

    def join(self) -> None:
        self._thread.join(timeout=WORKER_SHUTDOWN_TIMEOUT_SECONDS)


@dataclass
class BoundedPipeReader:
    """Drain a probe pipe concurrently while retaining at most a fixed prefix."""

    stream: BinaryIO
    maximum_bytes: int = MAX_IMPORT_PROBE_OUTPUT_BYTES
    retain: bool = True
    _buffer: bytearray = field(default_factory=bytearray, init=False)
    _total_bytes: int = field(default=0, init=False)
    _thread: threading.Thread = field(init=False)

    def __post_init__(self) -> None:
        self._thread = threading.Thread(
            target=self._drain,
            name="localscribe-smoke-probe-pipe",
            daemon=True,
        )
        self._thread.start()

    def _drain(self) -> None:
        while True:
            try:
                chunk = os.read(self.stream.fileno(), 64 * 1024)
            except OSError:
                return
            if not chunk:
                return
            self._total_bytes += len(chunk)
            if self.retain and len(self._buffer) < self.maximum_bytes:
                remaining = self.maximum_bytes - len(self._buffer)
                self._buffer.extend(chunk[:remaining])

    @property
    def exceeded(self) -> bool:
        return self._total_bytes > self.maximum_bytes

    def finish(self) -> bytes:
        self._thread.join(timeout=WORKER_SHUTDOWN_TIMEOUT_SECONDS)
        if self._thread.is_alive():
            raise RuntimeError("candidate worker import probe output did not close")
        return bytes(self._buffer)


@dataclass
class WorkerResponseReader:
    """Read NDJSON without losing lines already buffered after a progress burst."""

    process: subprocess.Popen[bytes]
    pending: bytearray = field(default_factory=bytearray)

    def receive(self, *, timeout_seconds: float) -> dict[str, Any]:
        if self.process.stdout is None:
            raise RuntimeError("candidate worker stdout is unavailable")
        deadline = time.monotonic() + timeout_seconds
        while True:
            newline = self.pending.find(b"\n")
            if newline >= 0:
                if newline > MAX_WORKER_RESPONSE_BYTES:
                    raise RuntimeError("candidate worker response exceeds its safety limit")
                raw_line = bytes(self.pending[:newline])
                del self.pending[: newline + 1]
                try:
                    response = json.loads(raw_line)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise RuntimeError("candidate worker emitted invalid JSON") from error
                if not isinstance(response, dict):
                    raise TypeError("candidate worker emitted a non-object response")
                return response
            if len(self.pending) > MAX_WORKER_RESPONSE_BYTES:
                raise RuntimeError("candidate worker response exceeds its safety limit")
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                raise RuntimeError("candidate worker request timed out")
            ready, _, _ = select.select([self.process.stdout.fileno()], [], [], remaining_seconds)
            if not ready:
                raise RuntimeError("candidate worker request timed out")
            chunk = os.read(self.process.stdout.fileno(), 64 * 1024)
            if not chunk:
                raise RuntimeError("candidate worker exited without a response")
            self.pending.extend(chunk)


def require_directory(path: Path, root: Path, label: str) -> Path:
    try:
        original = path.lstat()
        resolved = path.resolve(strict=True)
        metadata = resolved.stat()
    except OSError as error:
        raise RuntimeError(f"candidate {label} is unavailable: {path}") from error
    if (
        stat.S_ISLNK(original.st_mode)
        or not resolved.is_relative_to(root)
        or not stat.S_ISDIR(metadata.st_mode)
    ):
        raise RuntimeError(f"candidate {label} is not a directory inside Resources")
    return resolved


def require_file(
    path: Path,
    root: Path,
    label: str,
    *,
    executable: bool = False,
    allow_symlink: bool = False,
) -> Path:
    try:
        original = path.lstat()
        resolved = path.resolve(strict=True)
        metadata = resolved.stat()
    except OSError as error:
        raise RuntimeError(f"candidate {label} is unavailable: {path}") from error
    if (
        (not allow_symlink and stat.S_ISLNK(original.st_mode))
        or not resolved.is_relative_to(root)
        or not stat.S_ISREG(metadata.st_mode)
    ):
        raise RuntimeError(f"candidate {label} is not a regular file inside Resources")
    if executable and not bool(metadata.st_mode & stat.S_IXUSR):
        raise RuntimeError(f"candidate {label} is not executable")
    # Keep the venv launcher path intact. Resolving ``venv/bin/python3`` would
    # bypass the venv and lose the packaged worker's site-packages.
    return path


def candidate_resources(app_argument: str) -> CandidateResources:
    try:
        app = Path(app_argument).resolve(strict=True)
    except OSError as error:
        raise RuntimeError(f"candidate application is unavailable: {app_argument}") from error
    if app.suffix != ".app":
        raise RuntimeError("candidate application must be a macOS .app bundle")
    resources = require_directory(app / "Contents" / "Resources", app, "Resources")
    python = require_file(
        resources / "python-runtime" / "venv" / "bin" / "python3",
        resources,
        "Python runtime",
        executable=True,
        allow_symlink=True,
    )
    worker = require_directory(resources / "worker", resources, "worker directory")
    helper = require_file(
        resources / "native" / "macos" / "localscribe-fluidaudio-parakeet",
        resources,
        "FluidAudio helper",
        executable=True,
    )
    manifests = require_directory(resources / "model-manifest", resources, "model manifests")
    return CandidateResources(
        app=app,
        root=resources,
        python=python,
        worker=worker,
        helper=helper,
        manifests=manifests,
    )


def load_model_id(manifest_path: Path, family_id: str) -> str:
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"could not read packaged model manifest: {manifest_path}") from error
    model_id = raw.get("modelId") if isinstance(raw, dict) else None
    platform = raw.get("platform") if isinstance(raw, dict) else None
    manifest_family_id = raw.get("familyId") if isinstance(raw, dict) else None
    if (
        platform != "darwin-arm64"
        or manifest_family_id != family_id
        or not isinstance(model_id, str)
        or not model_id
    ):
        raise RuntimeError(f"invalid packaged macOS model manifest: {manifest_path}")
    return model_id


def assert_model_root_is_read_only(model_root: Path, *, allow_download: bool) -> None:
    """Refuse a local-only run that could trigger transaction recovery writes.

    `ensure_model` is read-only for a verified, already-present model. Its one
    exceptional local mutation is recovery of an interrupted owned install;
    a smoke must report that condition rather than repair a user's cache.
    """
    if allow_download:
        return
    try:
        pending_transactions = sorted(
            entry.name
            for entry in model_root.iterdir()
            if entry.name.startswith(MODEL_TRANSACTION_PREFIX)
        )
    except OSError as error:
        raise RuntimeError("model root cannot be inspected safely") from error
    if pending_transactions:
        raise RuntimeError(
            "model root has interrupted install transactions; refuse a read-only smoke: "
            + ", ".join(pending_transactions)
        )


def worker_environment(*, role: str) -> dict[str, str]:
    if role not in {"inference", "installer"}:
        raise ValueError("worker role must be inference or installer")
    environment = {
        "HOME": str(Path.home()),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
        "LOCALSCRIBE_WORKER_ROLE": role,
    }
    if role == "inference":
        # The load request is already local-only. This is a second independent
        # guard against an accidental library-default network request.
        environment["HF_HUB_OFFLINE"] = "1"
        environment["TRANSFORMERS_OFFLINE"] = "1"
        environment["UV_OFFLINE"] = "1"
    return environment


def start_owned_process(
    command: list[str],
    *,
    cwd: Path,
    environment: dict[str, str],
) -> OwnedProcess:
    """Start a command behind a live session anchor that owns group cleanup."""
    status_read, status_write = os.pipe()
    control_read, control_write = os.pipe()
    try:
        process = subprocess.Popen(
            [
                command[0],
                "-B",
                "-E",
                "-c",
                OWNED_PROCESS_ANCHOR,
                str(status_write),
                str(control_read),
                *command,
            ],
            cwd=cwd,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(status_write, control_read),
            start_new_session=True,
        )
    except BaseException:
        for descriptor in (status_read, status_write, control_read, control_write):
            os.close(descriptor)
        raise
    os.close(status_write)
    os.close(control_read)
    return OwnedProcess(
        process=process,
        status_fd=status_read,
        control_fd=control_write,
    )


def wait_for_worker_exit(owned: OwnedProcess, timeout_seconds: float) -> int:
    if owned.worker_exit_code is not None:
        return owned.worker_exit_code
    deadline = time.monotonic() + timeout_seconds
    while True:
        newline = owned.status_pending.find(b"\n")
        if newline >= 0:
            raw_exit_code = bytes(owned.status_pending[:newline])
            if not raw_exit_code or len(raw_exit_code) > 8:
                raise RuntimeError("candidate worker anchor returned invalid status")
            try:
                exit_code = int(raw_exit_code.decode("ascii"))
            except (UnicodeDecodeError, ValueError) as error:
                raise RuntimeError("candidate worker anchor returned invalid status") from error
            if exit_code < -255 or exit_code > 255:
                raise RuntimeError("candidate worker anchor returned invalid status")
            owned.worker_exit_code = exit_code
            os.close(owned.status_fd)
            owned.status_fd = -1
            return exit_code
        if len(owned.status_pending) > 8:
            raise RuntimeError("candidate worker anchor returned invalid status")
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            raise RuntimeError("candidate worker did not exit in time")
        ready, _, _ = select.select([owned.status_fd], [], [], remaining_seconds)
        if not ready:
            raise RuntimeError("candidate worker did not exit in time")
        chunk = os.read(owned.status_fd, 16)
        if not chunk:
            raise RuntimeError("candidate worker anchor exited without status")
        owned.status_pending.extend(chunk)


def retire_owned_process(owned: OwnedProcess) -> None:
    """Ask the live anchor to retire its own group, never a cached numeric PGID."""
    if owned.retired:
        return
    process = owned.process
    if process.stdin is not None and not process.stdin.closed:
        try:
            process.stdin.close()
        except OSError:
            pass
    if process.poll() is not None:
        if owned.control_fd >= 0:
            os.close(owned.control_fd)
            owned.control_fd = -1
        if owned.status_fd >= 0:
            os.close(owned.status_fd)
            owned.status_fd = -1
        raise RuntimeError("candidate worker ownership anchor exited unexpectedly")
    command_failed = False
    try:
        if owned.control_fd >= 0:
            os.write(owned.control_fd, b"T")
            time.sleep(PROCESS_GROUP_POLL_SECONDS)
            os.write(owned.control_fd, b"K")
    except OSError:
        command_failed = True
    if owned.control_fd >= 0:
        os.close(owned.control_fd)
        owned.control_fd = -1
    try:
        anchor_exit_code = process.wait(timeout=WORKER_SHUTDOWN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("candidate worker ownership anchor did not exit") from error
    if owned.status_fd >= 0:
        os.close(owned.status_fd)
        owned.status_fd = -1
    if command_failed or anchor_exit_code != -signal.SIGKILL:
        raise RuntimeError("candidate worker ownership anchor exited unexpectedly")
    owned.retired = True


def assert_packaged_imports(
    candidate: CandidateResources,
    manifest_filename: str,
    environment: dict[str, str],
) -> None:
    probe = (
        "import json, sys\n"
        "from pathlib import Path\n"
        "from localscribe_worker import worker\n"
        "print(json.dumps({\n"
        "  'module': str(Path(worker.__file__).resolve()),\n"
        "  'manifest': str(worker._manifest_path(sys.argv[1]).resolve()),\n"
        "  'helper': str(worker._fluid_audio_helper_path().resolve()),\n"
        "}, sort_keys=True))\n"
    )
    owned = start_owned_process(
        [str(candidate.python), "-B", "-E", "-c", probe, manifest_filename],
        cwd=candidate.worker,
        environment=environment,
    )
    process = owned.process
    if process.stdout is None or process.stderr is None:
        raise RuntimeError("candidate worker import probe pipes are unavailable")
    stdout = BoundedPipeReader(process.stdout)
    stderr = BoundedPipeReader(process.stderr, retain=False)
    exit_error: RuntimeError | None = None
    exit_code: int | None = None
    try:
        exit_code = wait_for_worker_exit(
            owned,
            WORKER_SHUTDOWN_TIMEOUT_SECONDS,
        )
    except RuntimeError as error:
        exit_error = error
    finally:
        retire_owned_process(owned)
    stdout_bytes = stdout.finish()
    stderr.finish()
    if stdout.exceeded or stderr.exceeded:
        raise RuntimeError("candidate worker import probe output exceeds its safety limit")
    if exit_error is not None:
        raise RuntimeError("candidate worker import probe failed to exit") from exit_error
    if exit_code is None:
        raise RuntimeError("candidate worker import probe returned no exit status")
    if exit_code != 0:
        raise RuntimeError(f"candidate worker import probe exited with code {exit_code}")
    try:
        locations = json.loads(stdout_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("candidate worker import probe emitted invalid JSON") from error
    expected_module = (candidate.worker / "localscribe_worker" / "worker.py").resolve()
    expected_manifest = (candidate.manifests / manifest_filename).resolve()
    expected_helper = candidate.helper.resolve()
    if locations != {
        "helper": str(expected_helper),
        "manifest": str(expected_manifest),
        "module": str(expected_module),
    }:
        raise RuntimeError("candidate worker resolved a source-tree or unexpected resource")


def validate_install_progress(
    response: dict[str, Any],
    *,
    request_id: str,
    state: InstallProgressState,
) -> None:
    """Accept only the exact bounded install-progress sequence in the worker protocol."""
    if frozenset(response) != frozenset(
        {"type", "id", "phase", "completedBytes", "totalBytes"}
    ):
        raise RuntimeError("candidate install progress has an invalid shape")
    if response.get("id") != request_id:
        raise RuntimeError("candidate install progress is not correlated to its request")
    phase = response.get("phase")
    completed_bytes = response.get("completedBytes")
    total_bytes = response.get("totalBytes")
    if (
        phase not in {"downloading", "verifying"}
        or isinstance(completed_bytes, bool)
        or not isinstance(completed_bytes, int)
        or isinstance(total_bytes, bool)
        or not isinstance(total_bytes, int)
        or total_bytes < 1
        or total_bytes > MAX_PROTOCOL_INTEGER
        or completed_bytes < 0
        or completed_bytes > total_bytes
    ):
        raise RuntimeError("candidate install progress has invalid byte counts")
    state.events += 1
    if state.events > MAX_INSTALL_PROGRESS_EVENTS:
        raise RuntimeError("candidate install progress exceeded its event limit")
    if state.total_bytes is None:
        if phase != "verifying" or completed_bytes != 0:
            raise RuntimeError("candidate install progress did not begin verification at zero")
        state.total_bytes = total_bytes
        state.phase = phase
        return
    if total_bytes != state.total_bytes:
        raise RuntimeError("candidate install progress changed its total byte count")
    if phase == state.phase:
        if completed_bytes < state.completed_bytes:
            raise RuntimeError("candidate install progress is not monotonic")
        state.completed_bytes = completed_bytes
        return
    if (
        state.phase == "verifying"
        and phase == "downloading"
        and not state.saw_download
        and not state.saw_post_download_verification
        and completed_bytes == 0
    ):
        state.phase = phase
        state.completed_bytes = completed_bytes
        state.saw_download = True
        return
    if (
        state.phase == "downloading"
        and phase == "verifying"
        and state.saw_download
        and not state.saw_post_download_verification
        and completed_bytes == 0
    ):
        state.phase = phase
        state.completed_bytes = completed_bytes
        state.saw_post_download_verification = True
        return
    raise RuntimeError("candidate install progress changed phase unexpectedly")


def request(
    process: subprocess.Popen[bytes],
    reader: WorkerResponseReader,
    payload: dict[str, Any],
    *,
    timeout_seconds: int = WORKER_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    if process.stdin is None:
        raise RuntimeError("candidate worker stdin is unavailable")
    request_payload = {**payload, "id": str(uuid.uuid4())}
    process.stdin.write((json.dumps(request_payload) + "\n").encode("utf-8"))
    process.stdin.flush()
    deadline = time.monotonic() + timeout_seconds
    progress = InstallProgressState()
    while True:
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            raise RuntimeError("candidate worker request timed out")
        response = reader.receive(timeout_seconds=remaining_seconds)
        if response.get("id") != request_payload["id"]:
            raise RuntimeError("candidate worker response is not correlated to its request")
        if response.get("type") == "model_install_progress":
            if payload["type"] != "install_model":
                raise RuntimeError("candidate worker sent install progress for a non-install request")
            validate_install_progress(
                response,
                request_id=request_payload["id"],
                state=progress,
            )
            continue
        if response.get("type") == "error":
            raise RuntimeError(f"candidate worker rejected {payload['type']}: {response.get('code')}")
        return response


def require_response_type(response: dict[str, Any], expected: str) -> None:
    if response.get("type") != expected:
        raise RuntimeError(f"candidate worker returned {response.get('type')!r}, expected {expected!r}")


def wait_for_exit(owned: OwnedProcess) -> None:
    try:
        exit_code = wait_for_worker_exit(owned, WORKER_SHUTDOWN_TIMEOUT_SECONDS)
    except RuntimeError as error:
        raise RuntimeError("candidate worker did not acknowledge shutdown in time") from error
    if exit_code != 0:
        raise RuntimeError(f"candidate worker exited with code {exit_code}")


def read_smoke_pcm(audio_path: Path) -> bytes:
    with wave.open(str(audio_path), "rb") as wav:
        if (
            wav.getnchannels() != 1
            or wav.getsampwidth() != 2
            or wav.getframerate() != 16_000
            or wav.getcomptype() != "NONE"
        ):
            raise RuntimeError("live smoke audio must be mono 16 kHz PCM16 WAV")
        frame_count = wav.getnframes()
        if frame_count > MAX_SMOKE_AUDIO_BYTES // 2:
            raise RuntimeError(
                f"smoke audio exceeds the {MAX_SMOKE_AUDIO_SECONDS}-second safety limit"
            )
        return wav.readframes(frame_count)


def require_nonempty_final(final: dict[str, Any], *, mode: str) -> None:
    text = final.get("text")
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError(f"candidate {mode} smoke returned an empty final transcript")


def install_model(
    candidate: CandidateResources,
    *,
    model_root: Path,
    model_id: str,
    tier: str,
    compute_type: str,
) -> None:
    """Install through a short-lived online worker with no inference capability."""
    environment = worker_environment(role="installer")
    owned = start_owned_process(
        [str(candidate.python), "-B", "-E", "-m", "localscribe_worker"],
        cwd=candidate.worker,
        environment=environment,
    )
    process = owned.process
    stderr = WorkerStderrReader(process)
    reader = WorkerResponseReader(process)
    try:
        hello = reader.receive(timeout_seconds=WORKER_SHUTDOWN_TIMEOUT_SECONDS)
        require_response_type(hello, "hello")
        installed = request(
            process,
            reader,
            {
                "type": "install_model",
                "tier": tier,
                "modelId": model_id,
                "computeType": compute_type,
                "modelRoot": str(model_root),
                "allowDownload": True,
            },
        )
        require_response_type(installed, "model_installed")
        shutdown = request(
            process,
            reader,
            {"type": "shutdown"},
            timeout_seconds=WORKER_SHUTDOWN_TIMEOUT_SECONDS,
        )
        require_response_type(shutdown, "shutdown")
        wait_for_exit(owned)
    finally:
        retire_owned_process(owned)
        stderr.join()


def smoke_mode(
    candidate: CandidateResources,
    *,
    model_root: Path,
    audio_path: Path,
    model_id: str,
    tier: str,
    compute_type: str,
    mode: str,
    pcm16: bytes,
    repeat: int,
) -> dict[str, Any]:
    environment = worker_environment(role="inference")
    owned = start_owned_process(
        [str(candidate.python), "-B", "-E", "-m", "localscribe_worker"],
        cwd=candidate.worker,
        environment=environment,
    )
    process = owned.process
    stderr = WorkerStderrReader(process)
    reader = WorkerResponseReader(process)
    try:
        hello = reader.receive(timeout_seconds=WORKER_SHUTDOWN_TIMEOUT_SECONDS)
        require_response_type(hello, "hello")
        ready = request(
            process,
            reader,
            {
                "type": "load_model",
                "tier": tier,
                "modelId": model_id,
                "computeType": compute_type,
                "modelRoot": str(model_root),
                "asrMode": mode,
                "allowDownload": False,
            },
        )
        require_response_type(ready, "model_ready")
        if mode == "after-stop":
            finals = [
                request(
                    process,
                    reader,
                    {
                        "type": "transcribe",
                        "audioPath": str(audio_path),
                        "allowedRoot": str(audio_path.parent),
                        "language": "English",
                        "context": "" if compute_type.startswith("coreml-") else "LocalScribe",
                    },
                )
                for _ in range(repeat)
            ]
            for final in finals:
                require_response_type(final, "final")
                require_nonempty_final(final, mode=mode)
            partial_count = 0
        else:
            finals = []
            partial_count = 0
            for _ in range(repeat):
                started = request(
                    process,
                    reader,
                    {"type": "begin_live", "language": "English", "context": ""},
                )
                require_response_type(started, "live_started")
                for offset in range(0, len(pcm16), 8 * 1024):
                    chunk = pcm16[offset : offset + 8 * 1024]
                    if not chunk:
                        continue
                    partial = request(
                        process,
                        reader,
                        {
                            "type": "append_live",
                            "audioBase64": base64.b64encode(chunk).decode("ascii"),
                        },
                    )
                    require_response_type(partial, "partial")
                    partial_count += 1
                final = request(process, reader, {"type": "finish_live"})
                require_response_type(final, "final")
                require_nonempty_final(final, mode=mode)
                finals.append(final)
        shutdown = request(
            process,
            reader,
            {"type": "shutdown"},
            timeout_seconds=WORKER_SHUTDOWN_TIMEOUT_SECONDS,
        )
        require_response_type(shutdown, "shutdown")
        wait_for_exit(owned)
        return {
            "mode": mode,
            "finalCount": len(finals),
            "finalTextLengths": [len(str(final.get("text", ""))) for final in finals],
            "partialCount": partial_count,
        }
    finally:
        retire_owned_process(owned)
        stderr.join()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--app",
        required=True,
        help="Fresh candidate .app bundle. Its Resources are the only runtime inputs.",
    )
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument(
        "--family",
        choices=tuple(MACOS_FAMILY_TIER_MANIFESTS),
        default=PARAKEET_FAMILY,
        help="Curated local ASR family to smoke; Parakeet is the macOS default.",
    )
    parser.add_argument("--tier", choices=("high", "medium", "low"), default="medium")
    parser.add_argument(
        "--mode",
        choices=("after-stop", "live", "both"),
        default="both",
        help="Exercise batch, incremental, or both recognition paths. Both is Parakeet-only.",
    )
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="Transcribe the same fixture repeatedly in one worker process to prove warm reuse.",
    )
    parser.add_argument(
        "--allow-download",
        action="store_true",
        help="Explicitly permit downloading the pinned tier into --model-root.",
    )
    args = parser.parse_args()
    if args.repeat < 1 or args.repeat > 20:
        parser.error("--repeat must be between 1 and 20")
    family_tiers = MACOS_FAMILY_TIER_MANIFESTS[args.family]
    if args.tier not in family_tiers:
        parser.error(f"{args.family} has no {args.tier} profile")
    if args.mode in {"live", "both"} and args.family != PARAKEET_FAMILY:
        parser.error("--mode live and --mode both require parakeet-unified-en-0-6b")

    candidate = candidate_resources(args.app)
    try:
        model_root = Path(args.model_root).resolve(strict=True)
    except OSError as error:
        raise RuntimeError(f"model root is unavailable: {args.model_root}") from error
    if not model_root.is_dir():
        raise RuntimeError("model root must be an existing directory")
    assert_model_root_is_read_only(model_root, allow_download=args.allow_download)
    try:
        audio_path = Path(args.audio).resolve(strict=True)
    except OSError as error:
        raise RuntimeError(f"audio fixture is unavailable: {args.audio}") from error
    if not audio_path.is_file():
        raise RuntimeError("audio fixture must be an ordinary file")
    pcm16 = read_smoke_pcm(audio_path)

    manifest_filename, compute_type = family_tiers[args.tier]
    manifest_path = require_file(
        candidate.manifests / manifest_filename,
        candidate.root,
        "selected model manifest",
    )
    model_id = load_model_id(manifest_path, args.family)
    environment = worker_environment(role="inference")
    assert_packaged_imports(candidate, manifest_filename, environment)
    if args.allow_download:
        install_model(
            candidate,
            model_root=model_root,
            model_id=model_id,
            tier=args.tier,
            compute_type=compute_type,
        )
    modes = ("after-stop", "live") if args.mode == "both" else (args.mode,)
    started_at = time.monotonic()
    reports = [
        smoke_mode(
            candidate,
            model_root=model_root,
            audio_path=audio_path,
            model_id=model_id,
            tier=args.tier,
            compute_type=compute_type,
            mode=mode,
            pcm16=pcm16,
            repeat=args.repeat,
        )
        for mode in modes
    ]
    print(
        json.dumps(
            {
                "candidate": candidate.app.name,
                "family": args.family,
                "tier": args.tier,
                "modes": reports,
                "elapsedMs": round((time.monotonic() - started_at) * 1000),
                "downloadAllowed": args.allow_download,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
