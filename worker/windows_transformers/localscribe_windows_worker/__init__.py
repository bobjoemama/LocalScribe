"""LocalScribe's private Windows faster-whisper/CTranslate2 worker."""

from .worker import PROTOCOL_VERSION, run_worker

__all__ = ["PROTOCOL_VERSION", "run_worker"]
