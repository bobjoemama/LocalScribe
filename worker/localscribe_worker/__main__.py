from __future__ import annotations

import os
import sys

# Hugging Face reads its offline setting when imported. Establish the negative
# network capability before importing any worker/runtime module, and force it
# on for every normal invocation (including the packaged smoke command, which
# intentionally omits a role and therefore defaults to inference).
worker_role = os.environ.get("LOCALSCRIBE_WORKER_ROLE", "inference")
if worker_role == "inference":
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["UV_OFFLINE"] = "1"

from .worker import run_worker  # noqa: E402 - offline flags must precede dependency imports

if __name__ == "__main__":
    raise SystemExit(
        run_worker(
            input_stream=sys.stdin.buffer,
            output_stream=sys.stdout,
            error_stream=sys.stderr,
            worker_role=worker_role,
        )
    )
