# LocalScribe privacy boundary

LocalScribe performs speech recognition on the Mac and does not send audio or
transcripts to a transcription API. It has no account requirement, telemetry
service, remote prompt path, cloud inference fallback, or listening network
port.

## Network behavior

Normal dictation and model inference do not download or contact a fallback
service. Network access occurs only when the user explicitly installs a model
from the curated catalog. The install transaction accepts the repository and
immutable revision declared by the packaged manifest, verifies the expected
file set, byte sizes, and SHA-256 digests, and activates the completed artifact
atomically. LocalScribe does not accept an arbitrary model URL, executable
model plugin, custom loader, or remote prompt.

GitHub, npm, Python, Swift, and model-hosting access used while building from
source are developer toolchain activity, not application inference.

## Data stored on the Mac

Electron's LocalScribe user-data directory is normally:

```text
~/Library/Application Support/LocalScribe/
```

It contains the SQLite database, model artifacts, diagnostics, and generated
runtime caches. The database stores transcript text, dictionary phrases and
replacements, snippet triggers and expansions, and scratchpad bodies as
ciphertext sealed with Electron `safeStorage`, backed by the macOS keystore.
Operational metadata needed by the product, such as timestamps, duration,
language/model identifiers, source application identifiers, settings, and
aggregate counts, is not represented as transcript plaintext but is not all
field-level encrypted.

LocalScribe attempts to apply user-only modes to its app-owned database and
diagnostics files and their direct directories. This best-effort hardening does
not defend against another process already running as the same macOS user or
establish descriptor-bound protection for every intermediate path. It is not a
substitute for FileVault, a locked login session, operating-system updates, or
normal control of the macOS user account.

## Raw audio lifecycle

Live dictation passes bounded PCM between LocalScribe's sandboxed renderer,
main process, worker, and native helper without retaining an audio history.
After-stop dictation writes one bounded WAV inside a randomly named,
user-access-only directory under the macOS temporary directory so the local
worker can read it.

LocalScribe attempts to remove the staged WAV after success, failure, or
cancellation. It removes its process-owned audio directory during orderly
shutdown and removes stale, direct-child LocalScribe audio directories during
the next launch. Cleanup is best effort: a filesystem or abrupt-process failure
can leave a temporary file until the next successful cleanup or operating-
system temporary-file cleanup. A cleanup error is recorded without storing the
audio or transcript in diagnostics.

## History and deletion

Saving transcript history is user-configurable. Deleting a transcript or
running retention cleanup removes the database row with SQLite
`secure_delete` enabled so freed pages are overwritten during deletion. The
database uses WAL journaling, so an older encrypted frame can remain in the
live WAL until a successful checkpoint or orderly close. Deletion is therefore
not an immediate physical-erasure guarantee. LocalScribe truncates the WAL
after its private-text migration and closes the database during orderly
shutdown, but storage media, filesystem snapshots, and external backups remain
outside the application's deletion guarantee.

Removing a model through Settings removes only the exact curated artifact
owned by its manifest. It does not remove transcripts, dictionary entries,
snippets, scratchpad notes, settings, or other model families.

Deleting the application from `/Applications` does not delete user data or
downloaded models. Preserve or remove the user-data directory separately only
after quitting LocalScribe and making any backup the user wants. Never delete
that directory as part of a routine upgrade or rollback.

## Diagnostics and exports

The diagnostics trail uses a closed event vocabulary and excludes transcript
text, audio, arbitrary paths, model prompts, clipboard contents, target window
titles, and raw exception messages. A user can copy the redacted trail for
support. A redacted diagnostic still reveals product version, platform,
architecture, lifecycle outcomes, permission states, and bounded failure
codes; review it before sharing if that metadata is sensitive in the user's
environment.

Exports are explicit user actions. Once an export is saved or shared outside
LocalScribe's user-data directory, its destination, copies, backups, and access
controls are the user's responsibility.
