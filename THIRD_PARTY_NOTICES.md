# Third-party notices

LocalScribe includes third-party open-source components. Each component remains
governed by its own license; the LocalScribe license does not replace those
terms.

Major runtime components include:

- Electron, React, React DOM, better-sqlite3, uiohook-napi, and Zod (MIT)
- CPython (Python Software Foundation License)
- FluidAudio (MIT)
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
3. the exact model license recorded in each packaged model manifest; and
4. an independent license review before public distribution.

Third-party copyright and license files contained in npm packages, Python
distributions, wheels, native modules, and model repositories must be retained
as required by their licenses.
