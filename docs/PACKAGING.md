# Packaging policy

LocalScribe treats packaging as a security boundary. Forge’s copy stage uses
whole source directories only to preserve the runtime paths expected by the
main process. `afterCopyExtraResources` immediately reduces those copies to an
OS/architecture allowlist before Electron Packager signs the app.

## Allowed custom resources

macOS arm64:

```text
worker/localscribe_worker/**
python-runtime/**
native/macos/active-target
model-manifest/whisper-large-v3-mlx.json
model-manifest/whisper-large-v3-mlx-8bit.json
model-manifest/whisper-large-v3-mlx-4bit.json
model-manifest/whisper-large-v2-mlx.json
model-manifest/whisper-large-v2-mlx-8bit.json
model-manifest/whisper-large-v2-mlx-4bit.json
```

Windows x64:

```text
worker/windows_transformers/localscribe_windows_worker/**
python-runtime-windows/**
native/windows/active-target.exe
branding/LocalScribe.ico
model-manifest/faster-whisper-large-v3.json
model-manifest/faster-whisper-large-v2.json
```

No `auto` manifest exists. Large-v3 is the default catalog family; large-v2 is
curated and addable, not an extension point. Mac packages carry exactly three
MLX manifests per family. Windows tiers share one physical manifest per family
and use a trusted TypeScript/Python compute-profile allowlist. Packaging does
not accept plugins, arbitrary model URLs, custom code/loaders, or extra
manifest paths. The catalog's revision and per-file SHA-256 pins are described
in [MODEL_CATALOG.md](MODEL_CATALOG.md).

## Gate order

1. Vite builds main, preload, and renderer with source maps disabled.
2. Forge prunes Node modules to the production dependency closure.
3. The staged package manifest is reduced to runtime and release metadata.
4. Package tests, maps, caches, shims, and lock/build files are removed.
5. Platform runtime, worker, helper, icon, and manifests are checked before copy.
6. Copied resources are reduced to the platform allowlist.
7. ASAR, ASAR-unpacked, symlinks, and all custom resources are inventoried.
8. Only a passing app enters platform signing/notarization.
9. The final packaged directory is inventoried again before a maker runs.

The gate rejects:

- an absent bundled Python executable or native helper;
- missing worker entrypoints or model manifests;
- opposite-platform worker/runtime/native payloads;
- extra or legacy manifests;
- development Node modules or executable shims;
- test directories/files, source maps, bytecode/caches, and repository locks;
- Swift/C/C++/PowerShell/shell build sources in the app;
- `.env`, credential/secret-like paths, signing material, and escaping/broken
  symlinks.

Runtime package metadata and upstream license files are retained. Python source
needed to import the worker/runtime is allowed; repository project files and
tests are not.

## Local verification

Packaging policy tests:

```sh
npm run test:packaging
```

Mac app and installer:

```sh
npm run make:mac
codesign --verify --deep --strict --verbose=4 \
  out/LocalScribe-darwin-arm64/LocalScribe.app
```

Windows app and installer must be produced on Windows:

```powershell
npm run verify:local:windows
npm run verify:local:windows -- -RequireCuda
```

The complete gate builds and smokes the package, validates the target-native
module inventory and both SBOMs, and checks every packaged `.exe`, `.dll`, and
`.node` plus Setup.exe. The Authenticode result is expected to be `NotSigned`
or an existing valid vendor signature for a normal validation build, and
`Valid` for every checked file in fail-closed public release mode.
