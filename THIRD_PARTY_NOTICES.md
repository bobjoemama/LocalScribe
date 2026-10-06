# Third-party notices

LocalScribe itself is licensed under the Apache License 2.0. It includes
third-party open-source components, each of which remains governed by its own
license; the LocalScribe license does not replace those terms.

Major runtime components include:

- Electron, React, React DOM, better-sqlite3, uiohook-napi, and Zod (MIT)
- CPython (Python Software Foundation License)
- transcribe.cpp and its embedded GGML sources (MIT), pinned at
  `e2f82cb6702315a1194f3bf1a6fee67cd2678447`. Exact upstream license texts are
  distributed as `resources/licenses/transcribe-cpp-LICENSE.txt` and
  `resources/licenses/transcribe-cpp-ggml-LICENSE.txt`. The embedded miniz codec's
  MIT license is in `resources/licenses/transcribe-cpp-miniz-LICENSE.txt`.
- Optional Canary-Qwen-2.5B weights by NVIDIA (CC BY 4.0), converted to GGUF
  with merged LoRA weights and lower-profile quantization by handy-computer.
  Original: https://huggingface.co/nvidia/canary-qwen-2.5b
  Conversion: https://huggingface.co/handy-computer/canary-qwen-2.5b-gguf/tree/3370d4e2f28cc70eea79dfc9f2f43fb91eef3163
  License: https://creativecommons.org/licenses/by/4.0/
  Weights are downloaded only at the user's request and are not included in
  the installer. High uses BF16; Medium and Low use Q8_0 and Q4_K_M conversions.
- FluidAudio 0.17.5 (Apache License 2.0). The exact upstream license from
  pinned revision `0b1f46289fe27d95b5e66ad8be46e64f5ee02ae7` is distributed
  as `resources/licenses/FluidAudio-0.17.5-LICENSE.txt`.
- FastCluster sources embedded by that pinned FluidAudio revision
  (BSD 2-Clause). FluidAudio's exact upstream attribution and license text from
  `ThirdPartyLicenses/fastcluster-LICENSE.md` is distributed as
  `resources/licenses/FluidAudio-0.17.5-fastcluster-LICENSE.md`.
- The FluidAudio Swift implementation based on the VBx speaker-diarization
  algorithm (Apache License 2.0; copyright 2021-2024 BUT Speech@FIT).
  FluidAudio's exact upstream attribution and license text from
  `ThirdPartyLicenses/vbx-LICENSE.md` is distributed as
  `resources/licenses/FluidAudio-0.17.5-vbx-LICENSE.md`.
- NemoTextProcessing 0.3.1 (Apache-2.0), statically linked by FluidAudio.
  The upstream attribution covering NeMo grammars and Rust dependencies is
  `resources/licenses/FluidAudio-0.17.5-NemoTextProcessing-LICENSE.md`. The exact
  text-processing-rs release LICENSE, NOTICE, and third-party attribution are
  retained as `resources/licenses/NemoTextProcessing-0.3.1-*`.
  FluidAudio Japanese and Spanish/French G2P attributions are also retained.
- Moonshine Voice Swift 0.1.5 (MIT), pinned to
  `45a14f9edf1f2a6913d3aff38c1fd4e72d5b7daa`. Its static runtime includes
  ONNX Runtime, kaldi-native-fbank, utf8proc, utf-8, and nlohmann/json;
  their license texts are retained as `resources/licenses/Moonshine*LICENSE.txt`.
- MLX, MLX Audio, and the Python inference stack (their packaged
  upstream licenses)

The pinned MLX Audio 0.4.6 package is modified during the build to remove its
unused Whisper backend and that backend's eager import. The exact source hash,
patch, and verification are in `scripts/prune-mlx-audio-whisper.py`; packaged
metadata and the Python SBOM record the change. Upstream licenses remain intact.
Qwen's shared Transformers audio feature extractor is retained.

This summary is not an exhaustive dependency list. Every release candidate
must include:

1. the macOS CycloneDX core-runtime SBOM, generated with
   `npm run --silent sbom:runtime:macos`;
2. the locked Python-dependency CycloneDX SBOM, with Python
   package metadata and license files preserved in the bundled runtime;
3. exact licenses for compiled native dependencies under the packaged
   `licenses/` resource directory;
4. LocalScribe's `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md` files;
5. the exact model license recorded in each packaged model manifest; and
6. an independent license review before public distribution.

Third-party copyright and license files contained in npm packages, Python
distributions, wheels, native modules, and model repositories must be retained
as required by their licenses.
