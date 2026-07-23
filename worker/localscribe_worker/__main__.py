from __future__ import annotations

import sys

from .worker import run_worker


if __name__ == "__main__":
    raise SystemExit(
        run_worker(
            input_stream=sys.stdin.buffer,
            output_stream=sys.stdout,
            error_stream=sys.stderr,
        )
    )
