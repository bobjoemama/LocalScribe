# Third-party notices

LocalScribe itself is licensed under the Apache License 2.0. It includes
third-party open-source components, each of which remains governed by its own
license; the LocalScribe license does not replace those terms.

Major runtime components include:

- Electron, React, React DOM, better-sqlite3, uiohook-napi, and Zod (MIT)
- CPython (Python Software Foundation License)
- FluidAudio 0.15.5 (Apache License 2.0). The exact upstream license from
  pinned revision `19600a485baa4998812e4654b70d2bab8f2c9949` is distributed
  as `resources/licenses/FluidAudio-0.15.5-LICENSE.txt`.
- FastCluster sources embedded by that pinned FluidAudio revision
  (BSD 2-Clause). FluidAudio's exact upstream attribution and license text from
  `ThirdPartyLicenses/fastcluster-LICENSE.md` is distributed as
  `resources/licenses/FluidAudio-0.15.5-fastcluster-LICENSE.md`.
- The FluidAudio Swift implementation based on the VBx speaker-diarization
  algorithm (Apache License 2.0; copyright 2021-2024 BUT Speech@FIT).
  FluidAudio's exact upstream attribution and license text from
  `ThirdPartyLicenses/vbx-LICENSE.md` is distributed as
  `resources/licenses/FluidAudio-0.15.5-vbx-LICENSE.md`.
- MLX, MLX Whisper, and the Python inference stack (their packaged
  upstream licenses)
- OpenAI Whisper model artifacts (the license declared in each immutable
  packaged model manifest)

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
