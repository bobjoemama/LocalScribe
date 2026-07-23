# Third-party notices

LocalScribe is proprietary software built on third-party open-source
components. Each component remains governed by its own license; the LocalScribe
license does not replace those terms.

Major runtime components include:

- Electron, React, React DOM, better-sqlite3, uiohook-napi, and Zod (MIT)
- electron-squirrel-startup (Apache-2.0)
- CPython (Python Software Foundation License)
- MLX, MLX Whisper, and the macOS Python inference stack (their packaged
  upstream licenses)
- faster-whisper and CTranslate2 on Windows (MIT)
- OpenAI Whisper model artifacts (the license declared in each immutable
  packaged model manifest)

This summary is not an exhaustive dependency list. Every release candidate
must include:

1. a CycloneDX production npm SBOM generated with `npm run --silent sbom`;
2. Python package metadata and license files preserved in the bundled runtime;
3. the exact model license recorded in each packaged model manifest; and
4. an independent license review before public distribution.

Third-party copyright and license files contained in npm packages, Python
distributions, wheels, native modules, and model repositories must be retained
as required by their licenses.
