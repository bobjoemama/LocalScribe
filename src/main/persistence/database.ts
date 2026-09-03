import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { safeStorage } from "electron";
import {
  DEFAULT_SETTINGS,
  MAX_HISTORY_ITEMS,
  MAX_PERSISTED_PRIVATE_TEXT_CIPHERTEXT_BYTES,
  MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES,
  appProfileSchema,
  appSettingsSchema,
  dictionaryEntrySchema,
  migratePersistedAppSettings,
  sanitizeSourceApplicationId,
  sourceApplicationIdSchema,
  scratchpadNoteSchema,
  snippetSchema,
  transcriptionSchema,
  type AppSettings,
  type AppProfile,
  type DictionaryEntry,
  type HistoryListResult,
  type ScratchpadNote,
  type ScratchpadListResult,
  type Snippet,
  type Transcription,
} from "../../shared/contracts";
import { applicationIdsMatch } from "../../shared/appIdentity";
import { migrations } from "./migrations";

interface TranscriptionRow {
  id: unknown;
  created_at: unknown;
  duration_ms: unknown;
  text_encrypted: unknown;
  language: unknown;
  model_id: unknown;
  status: unknown;
  source_app_id: unknown;
}

interface DictionaryRow {
  id: unknown;
  phrase_encrypted: unknown;
  replacement_encrypted: unknown;
  created_at: unknown;
}

interface SnippetRow {
  id: unknown;
  trigger_encrypted: unknown;
  expansion_encrypted: unknown;
  created_at: unknown;
}

interface LegacyDictionaryRow {
  id: string;
  phrase: string | null;
  replacement: string | null;
  created_at: number;
  updated_at: number;
}

interface LegacySnippetRow {
  id: string;
  trigger: string | null;
  expansion_encrypted: Buffer | null;
  created_at: number;
  updated_at: number;
}

interface AppProfileRow {
  id: unknown;
  app_id: unknown;
  settings_json: unknown;
  created_at: unknown;
}

interface ScratchpadNoteRow {
  id: unknown;
  body_encrypted: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const USER_ONLY_DIRECTORY_MODE = 0o700;
const USER_ONLY_FILE_MODE = 0o600;
const MAX_PERSISTED_COLLECTION_ROWS = 10_000;
const DATABASE_READ_PAGE_SIZE = 250;
const MAX_ENCRYPTED_FIELD_BYTES = MAX_PERSISTED_PRIVATE_TEXT_CIPHERTEXT_BYTES;
const MAX_SETTINGS_JSON_BYTES = 256 * 1024;
const MAX_EXPORT_PLAINTEXT_BYTES = 32 * 1024 * 1024;

interface FileIdentity {
  dev: number;
  ino: number;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closedPathError(detail: string): Error {
  return new Error(`Refusing unsafe database path: ${detail}`);
}

function lstatOrNull(targetPath: string): Stats | null {
  try {
    return lstatSync(targetPath, { bigint: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Validate every pathname component before SQLite gets a chance to follow it.
 *
 * This closes pre-created intermediate and final symlinks. It does not claim to
 * defeat a hostile same-UID process that swaps components between syscalls;
 * that stronger guarantee requires a descriptor-relative SQLite VFS rather
 * than the pathname-only API exposed by better-sqlite3. Post-open identity
 * checks below detect, close, and reject observed races, but cannot undo writes
 * SQLite may already have made during that narrow interval.
 */
function prepareDatabasePath(databasePath: string): {
  parentDescriptor: number;
  parentIdentity: FileIdentity;
  existingDatabaseIdentity: FileIdentity | null;
} {
  if (!path.isAbsolute(databasePath)) throw closedPathError("path must be absolute");
  const resolvedDatabasePath = path.resolve(databasePath);
  const parentPath = path.dirname(resolvedDatabasePath);
  const root = path.parse(parentPath).root;
  const components = path.relative(root, parentPath).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    let info = lstatOrNull(current);
    if (info === null) {
      if (index !== components.length - 1) {
        throw closedPathError("a parent ancestor does not exist");
      }
      mkdirSync(current, { mode: USER_ONLY_DIRECTORY_MODE });
      info = lstatSync(current, { bigint: false });
    }
    if (info === null) throw closedPathError("the direct parent could not be created");
    if (info.isSymbolicLink()) throw closedPathError("a parent component is a symbolic link");
    if (!info.isDirectory()) throw closedPathError("a parent component is not a directory");
  }

  const parentDescriptor = openSync(
    parentPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    const parentInfo = fstatSync(parentDescriptor);
    if (!parentInfo.isDirectory()) throw closedPathError("the direct parent is not a directory");
    fchmodSync(parentDescriptor, USER_ONLY_DIRECTORY_MODE);
    const existingDatabase = lstatOrNull(resolvedDatabasePath);
    if (existingDatabase?.isSymbolicLink()) {
      throw closedPathError("the database file is a symbolic link");
    }
    if (existingDatabase !== null && !existingDatabase.isFile()) {
      throw closedPathError("the database path is not a regular file");
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = lstatOrNull(`${resolvedDatabasePath}${suffix}`);
      if (sidecar?.isSymbolicLink()) {
        throw closedPathError("a database sidecar is a symbolic link");
      }
      if (sidecar !== null && !sidecar.isFile()) {
        throw closedPathError("a database sidecar is not a regular file");
      }
    }
    const existingDatabaseIdentity = existingDatabase === null
      ? null
      : { dev: existingDatabase.dev, ino: existingDatabase.ino };
    return {
      parentDescriptor,
      parentIdentity: { dev: parentInfo.dev, ino: parentInfo.ino },
      existingDatabaseIdentity,
    };
  } catch (error) {
    closeSync(parentDescriptor);
    throw error;
  }
}

function revalidateDatabasePathAfterOpen(
  databasePath: string,
  guard: ReturnType<typeof prepareDatabasePath>,
): void {
  const resolvedDatabasePath = path.resolve(databasePath);
  const parentPath = path.dirname(resolvedDatabasePath);
  const heldParent = fstatSync(guard.parentDescriptor);
  const namedParent = lstatSync(parentPath, { bigint: false });
  if (
    namedParent.isSymbolicLink()
    || !namedParent.isDirectory()
    || !sameIdentity(guard.parentIdentity, heldParent)
    || !sameIdentity(guard.parentIdentity, namedParent)
  ) {
    throw closedPathError("the database parent identity changed while opening");
  }

  const namedDatabase = lstatSync(resolvedDatabasePath, { bigint: false });
  if (namedDatabase.isSymbolicLink() || !namedDatabase.isFile()) {
    throw closedPathError("the opened database is not a regular file");
  }
  if (
    guard.existingDatabaseIdentity !== null
    && !sameIdentity(guard.existingDatabaseIdentity, namedDatabase)
  ) {
    throw closedPathError("the database file identity changed while opening");
  }
  const databaseDescriptor = openSync(
    resolvedDatabasePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedDatabase = fstatSync(databaseDescriptor);
    if (!openedDatabase.isFile() || !sameIdentity(openedDatabase, namedDatabase)) {
      throw closedPathError("the database path changed during post-open validation");
    }
    fchmodSync(databaseDescriptor, USER_ONLY_FILE_MODE);
  } finally {
    closeSync(databaseDescriptor);
  }
}

function openHardenedDatabase(databasePath: string): Database.Database {
  if (databasePath === ":memory:") return new Database(databasePath);
  const guard = prepareDatabasePath(databasePath);
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath);
    revalidateDatabasePathAfterOpen(databasePath, guard);
    return database;
  } catch (error) {
    database?.close();
    throw error;
  } finally {
    closeSync(guard.parentDescriptor);
  }
}

function canonicalRuleKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und");
}

/**
 * Is this the failure of an unreadable stored record, or a bug in our own code?
 *
 * `tryDecrypt` used to catch everything, which made a programming fault
 * indistinguishable from data this install can no longer read: a `TypeError`
 * from a refactor would silently shrink every history, snippet, and scratchpad
 * list instead of failing loudly, and the app would keep running while
 * appearing to have lost the user's data.
 *
 * A genuine seal failure comes out of Electron's `safeStorage` (or the platform
 * keystore beneath it) as a plain `Error`. The named JavaScript error types are
 * programming faults by construction and are rethrown.
 */
export function isDecryptionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return !(
    error instanceof TypeError
    || error instanceof RangeError
    || error instanceof ReferenceError
    || error instanceof SyntaxError
  );
}

function bestEffortSetMode(targetPath: string, mode: number, expectedType: "directory" | "file"): void {
  let descriptor: number | undefined;
  try {
    const typeFlag = expectedType === "directory" ? constants.O_DIRECTORY : 0;
    descriptor = openSync(
      targetPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | typeFlag,
    );
    const stats = fstatSync(descriptor);
    const matchesExpectedType =
      expectedType === "directory" ? stats.isDirectory() : stats.isFile();
    if (matchesExpectedType) fchmodSync(descriptor, mode);
  } catch {
    // Permission hardening is best-effort: an unsupported mode operation must not block startup.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor is only used for best-effort hardening.
      }
    }
  }
}

function isSafeDatabaseParent(databasePath: string, parentPath: string): boolean {
  if (!path.isAbsolute(databasePath)) return false;
  const resolvedParent = path.resolve(parentPath);
  const broadDirectories = new Set([
    path.parse(resolvedParent).root,
    path.resolve(process.cwd()),
    path.resolve(homedir()),
    path.resolve(tmpdir()),
  ]);
  return !broadDirectories.has(resolvedParent);
}

function hardenDatabasePermissions(databasePath: string): void {
  if (databasePath === ":memory:") return;

  const resolvedDatabasePath = path.resolve(databasePath);
  const parentPath = path.dirname(resolvedDatabasePath);
  if (isSafeDatabaseParent(databasePath, parentPath)) {
    bestEffortSetMode(parentPath, USER_ONLY_DIRECTORY_MODE, "directory");
  }
  for (const targetPath of [
    resolvedDatabasePath,
    `${resolvedDatabasePath}-wal`,
    `${resolvedDatabasePath}-shm`,
  ]) {
    bestEffortSetMode(targetPath, USER_ONLY_FILE_MODE, "file");
  }
}

export class LocalDatabase {
  private readonly db: Database.Database;
  private readonly defaultSettings: AppSettings;

  /** Reads that hit a record this install could not decrypt or validate. */
  private unreadableRecords = 0;

  constructor(path: string, defaultSettings: AppSettings = DEFAULT_SETTINGS) {
    this.defaultSettings = appSettingsSchema.parse(defaultSettings);
    this.db = openHardenedDatabase(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      /*
       * "Clear history" and the retention purge have to actually remove the
     * transcript, not just unlink its row. SQLite's default is to leave the
     * freed page contents in place, so every deleted transcript stayed in
     * `localscribe.db` byte for byte until some later insert happened to reuse
     * that page — a history-deletion control that
     * deleted nothing from the file. The stored values are ciphertext, so this
     * is not a plaintext leak, but the app's own claim about deletion has to be
     * true.
     *
     * `secure_delete` overwrites freed cells in the new database state, but an
     * older WAL frame may still retain prior ciphertext. Each history deletion
     * therefore also requests a truncating checkpoint and surfaces failure
     * instead of claiming that physical cleanup completed.
       */
      this.db.pragma("secure_delete = ON");
      this.db.pragma("synchronous = NORMAL");
      this.migrate();
      this.migratePrivateTextRules();
      this.normalizePersistedSettings();
      hardenDatabasePermissions(path);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  integrityCheck(): string {
    const row = this.db.pragma("integrity_check", { simple: true });
    return String(row);
  }

  listTranscriptions(limit = MAX_HISTORY_ITEMS): Transcription[] {
    const bounded = Math.max(1, Math.min(limit, MAX_HISTORY_ITEMS));
    const result: Transcription[] = [];
    let offset = 0;
    while (result.length < bounded && offset < MAX_PERSISTED_COLLECTION_ROWS) {
      const pageSize = Math.min(
        DATABASE_READ_PAGE_SIZE,
        MAX_PERSISTED_COLLECTION_ROWS - offset,
      );
      const rows = this.db
        .prepare(
          `SELECT id, created_at, duration_ms,
             CASE WHEN typeof(text_encrypted) = 'blob' AND length(text_encrypted) <= ?
               THEN text_encrypted ELSE NULL END AS text_encrypted,
             language, model_id, status, source_app_id
           FROM transcriptions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(MAX_ENCRYPTED_FIELD_BYTES, pageSize, offset) as TranscriptionRow[];
      for (const row of rows) {
        const transcription = this.decodeTranscription(row);
        if (transcription === null) continue;
        result.push(transcription);
        if (result.length === bounded) break;
      }
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
    if (result.length < bounded && offset >= MAX_PERSISTED_COLLECTION_ROWS) {
      const totalStored = this.countRows("transcriptions");
      if (totalStored > offset) this.markUnreadableRecord("limit");
    }
    return result;
  }

  /** A renderer-facing list that cannot make unreadable rows look absent. */
  listTranscriptionsWithIntegrity(limit = MAX_HISTORY_ITEMS): HistoryListResult {
    const bounded = Math.max(1, Math.min(limit, MAX_HISTORY_ITEMS));
    const before = this.unreadableRecords;
    const totalStored = this.countRows("transcriptions");
    const items: Transcription[] = [];
    let offset = 0;
    while (offset < Math.min(totalStored, MAX_PERSISTED_COLLECTION_ROWS)) {
      const pageSize = Math.min(
        DATABASE_READ_PAGE_SIZE,
        MAX_PERSISTED_COLLECTION_ROWS - offset,
      );
      const rows = this.db.prepare(
        `SELECT id, created_at, duration_ms,
           CASE WHEN typeof(text_encrypted) = 'blob' AND length(text_encrypted) <= ?
             THEN text_encrypted ELSE NULL END AS text_encrypted,
           language, model_id, status, source_app_id
         FROM transcriptions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).all(MAX_ENCRYPTED_FIELD_BYTES, pageSize, offset) as TranscriptionRow[];
      for (const row of rows) {
        const transcription = this.decodeTranscription(row);
        if (transcription !== null && items.length < bounded) items.push(transcription);
      }
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
    const skippedUnreadable = this.unreadableRecords - before;
    return {
      items,
      totalStored,
      skippedUnreadable,
      complete: skippedUnreadable === 0 && offset >= totalStored,
    };
  }

  /*
   * Counts and existence for the macOS application menu.
   *
   * The menu is rebuilt on every session transition — six times per dictation,
   * on the thread that is also driving text insertion — and it needs three
   * numbers: how many dictionary entries, how many snippets, and whether there
   * is a transcript to copy. It was getting them by listing the tables, which
   * decrypts every snippet expansion and one transcript to answer questions
   * that no plaintext is needed for.
   *
   * `COUNT(*)` is also the more truthful answer: `listSnippets` drops a row it
   * cannot decrypt, so a keychain problem quietly reduced the reported count
   * rather than the snippets existing.
   */
  countDictionary(): number {
    return (this.db
      .prepare("SELECT COUNT(*) AS total FROM dictionary_entries")
      .get() as { total: number }).total;
  }

  countSnippets(): number {
    return (this.db
      .prepare("SELECT COUNT(*) AS total FROM snippets")
      .get() as { total: number }).total;
  }

  hasTranscriptions(): boolean {
    return this.db.prepare("SELECT 1 FROM transcriptions LIMIT 1").get() !== undefined;
  }

  exportTranscriptions(): Transcription[] {
    return this.exportTranscriptionsWithIntegrity().transcriptions;
  }

  saveTranscription(input: Omit<Transcription, "id" | "createdAt">): Transcription {
    const encryptedText = this.encryptPersistedPrivateText(input.text, "Transcript");
    const result: Transcription = {
      ...input,
      sourceAppId: sanitizeSourceApplicationId(input.sourceAppId),
      id: randomUUID(),
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO transcriptions
          (id, created_at, duration_ms, text_encrypted, language, model_id, status, source_app_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        result.createdAt,
        result.durationMs,
        encryptedText,
        result.language,
        result.modelId,
        result.status,
        result.sourceAppId,
      );
    return result;
  }

  deleteTranscription(id: string): void {
    const changes = this.db.prepare("DELETE FROM transcriptions WHERE id = ?").run(id).changes;
    if (changes > 0) this.checkpointDeletedHistory("single history deletion");
  }

  clearTranscriptions(): void {
    const changes = this.db.prepare("DELETE FROM transcriptions").run().changes;
    if (changes > 0) this.checkpointDeletedHistory("history clear");
  }

  purgeExpiredTranscriptions(retentionDays: AppSettings["historyRetentionDays"]): number {
    if (retentionDays === 0) return 0;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const changes = this.db
      .prepare("DELETE FROM transcriptions WHERE created_at < ?")
      .run(cutoff).changes;
    if (changes > 0) this.checkpointDeletedHistory("history retention cleanup");
    return changes;
  }

  private checkpointDeletedHistory(operation: string): void {
    try {
      const result = this.db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
        busy?: unknown;
      }>;
      if (result[0]?.busy !== 0) {
        throw new Error("SQLite reported a busy WAL reader");
      }
    } catch (error) {
      // The logical DELETE already committed. Rejecting the operation is still
      // the truthful result for a UI that promises physical removal: closing
      // the final connection may checkpoint later, but that is not established
      // at this return boundary.
      console.warn(`LocalScribe could not complete physical ${operation} cleanup`);
      throw new Error(
        "History was removed from the list, but encrypted storage cleanup could not be completed.",
        { cause: error },
      );
    }
  }

  listDictionary(): DictionaryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id,
           CASE WHEN typeof(phrase_encrypted) = 'blob' AND length(phrase_encrypted) <= ?
             THEN phrase_encrypted ELSE NULL END AS phrase_encrypted,
           CASE WHEN typeof(replacement_encrypted) = 'blob' AND length(replacement_encrypted) <= ?
             THEN replacement_encrypted ELSE NULL END AS replacement_encrypted,
           created_at
         FROM dictionary_entries ORDER BY created_at, id LIMIT ?`,
      )
      .all(
        MAX_ENCRYPTED_FIELD_BYTES,
        MAX_ENCRYPTED_FIELD_BYTES,
        MAX_PERSISTED_COLLECTION_ROWS + 1,
      ) as DictionaryRow[];
    if (rows.length > MAX_PERSISTED_COLLECTION_ROWS) {
      rows.length = MAX_PERSISTED_COLLECTION_ROWS;
      this.markUnreadableRecord("limit");
    }
    return rows.flatMap((row) => {
      const phrase = this.tryDecrypt(row.phrase_encrypted);
      if (phrase === null) return [];
      const replacement = this.tryDecrypt(row.replacement_encrypted);
      if (replacement === null) return [];
      const parsed = dictionaryEntrySchema.safeParse({
        id: row.id,
        phrase,
        replacement,
        createdAt: row.created_at,
      });
      if (!parsed.success) {
        this.markUnreadableRecord("malformed");
        return [];
      }
      return [parsed.data];
    }).sort((left, right) => left.phrase.localeCompare(right.phrase));
  }

  saveDictionary(input: Pick<DictionaryEntry, "phrase" | "replacement">): DictionaryEntry {
    const validated = dictionaryEntrySchema.pick({ phrase: true, replacement: true }).parse(input);
    const phrase = validated.phrase.normalize("NFC");
    const now = Date.now();
    const unreadableBefore = this.unreadableRecords;
    const dictionary = this.listDictionary();
    if (this.unreadableRecords !== unreadableBefore) {
      throw new Error("A stored dictionary rule is unreadable; refusing a potentially duplicate save.");
    }
    const matches = dictionary.filter((entry) =>
      canonicalRuleKey(entry.phrase) === canonicalRuleKey(phrase),
    );
    if (matches.length > 1) {
      throw new Error("Multiple legacy dictionary rules have the same canonical phrase; delete one before saving.");
    }
    const existing = matches[0];
    const entry: DictionaryEntry = {
      id: existing?.id ?? randomUUID(),
      phrase,
      replacement: validated.replacement,
      createdAt: existing?.createdAt ?? now,
    };
    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(
          `UPDATE dictionary_entries
           SET phrase_encrypted = ?, replacement_encrypted = ?, updated_at = ? WHERE id = ?`,
        ).run(this.encrypt(entry.phrase), this.encrypt(entry.replacement), now, entry.id);
      } else {
        this.db.prepare(
          `INSERT INTO dictionary_entries
             (id, phrase_encrypted, replacement_encrypted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          entry.id,
          this.encrypt(entry.phrase),
          this.encrypt(entry.replacement),
          entry.createdAt,
          now,
        );
      }
    })();
    return entry;
  }

  deleteDictionary(id: string): void {
    this.db.prepare("DELETE FROM dictionary_entries WHERE id = ?").run(id);
  }

  listSnippets(): Snippet[] {
    const rows = this.db
      .prepare(
        `SELECT id,
           CASE WHEN typeof(trigger_encrypted) = 'blob' AND length(trigger_encrypted) <= ?
             THEN trigger_encrypted ELSE NULL END AS trigger_encrypted,
           CASE WHEN typeof(expansion_encrypted) = 'blob' AND length(expansion_encrypted) <= ?
             THEN expansion_encrypted ELSE NULL END AS expansion_encrypted,
           created_at
         FROM snippets ORDER BY created_at, id LIMIT ?`,
      )
      .all(
        MAX_ENCRYPTED_FIELD_BYTES,
        MAX_ENCRYPTED_FIELD_BYTES,
        MAX_PERSISTED_COLLECTION_ROWS + 1,
      ) as SnippetRow[];
    if (rows.length > MAX_PERSISTED_COLLECTION_ROWS) {
      rows.length = MAX_PERSISTED_COLLECTION_ROWS;
      this.markUnreadableRecord("limit");
    }
    return rows.flatMap((row) => {
      const trigger = this.tryDecrypt(row.trigger_encrypted);
      if (trigger === null) return [];
      const expansion = this.tryDecrypt(row.expansion_encrypted);
      if (expansion === null) return [];
      const parsed = snippetSchema.safeParse({
        id: row.id,
        trigger,
        expansion,
        createdAt: row.created_at,
      });
      if (!parsed.success) {
        this.markUnreadableRecord("malformed");
        return [];
      }
      return [parsed.data];
    }).sort((left, right) => left.trigger.localeCompare(right.trigger));
  }

  saveSnippet(input: Pick<Snippet, "trigger" | "expansion">): Snippet {
    const validated = snippetSchema.pick({ trigger: true, expansion: true }).parse(input);
    const trigger = validated.trigger.normalize("NFC");
    const now = Date.now();
    const unreadableBefore = this.unreadableRecords;
    const snippets = this.listSnippets();
    if (this.unreadableRecords !== unreadableBefore) {
      throw new Error("A stored snippet is unreadable; refusing a potentially duplicate save.");
    }
    const matches = snippets.filter((snippet) =>
      canonicalRuleKey(snippet.trigger) === canonicalRuleKey(trigger),
    );
    if (matches.length > 1) {
      throw new Error("Multiple legacy snippets have the same canonical trigger; delete one before saving.");
    }
    const existing = matches[0];
    const snippet: Snippet = {
      id: existing?.id ?? randomUUID(),
      trigger,
      expansion: validated.expansion,
      createdAt: existing?.createdAt ?? now,
    };
    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(
          `UPDATE snippets
           SET trigger_encrypted = ?, expansion_encrypted = ?, updated_at = ? WHERE id = ?`,
        ).run(this.encrypt(snippet.trigger), this.encrypt(snippet.expansion), now, snippet.id);
      } else {
        this.db.prepare(
          `INSERT INTO snippets
             (id, trigger_encrypted, expansion_encrypted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          snippet.id,
          this.encrypt(snippet.trigger),
          this.encrypt(snippet.expansion),
          snippet.createdAt,
          now,
        );
      }
    })();
    return snippet;
  }

  deleteSnippet(id: string): void {
    this.db.prepare("DELETE FROM snippets WHERE id = ?").run(id);
  }

  listProfiles(): AppProfile[] {
    const rows = this.db
      .prepare(
        `SELECT id, app_id,
           CASE WHEN typeof(settings_json) = 'text'
             AND length(CAST(settings_json AS BLOB)) <= ?
             THEN settings_json ELSE NULL END AS settings_json,
           created_at
         FROM app_profiles ORDER BY app_id LIMIT ?`,
      )
      .all(MAX_SETTINGS_JSON_BYTES, MAX_PERSISTED_COLLECTION_ROWS + 1) as AppProfileRow[];
    if (rows.length > MAX_PERSISTED_COLLECTION_ROWS) {
      rows.length = MAX_PERSISTED_COLLECTION_ROWS;
      this.markUnreadableRecord("limit");
    }
    return rows.flatMap((row) => {
      if (typeof row.settings_json !== "string") {
        this.markUnreadableRecord("malformed");
        return [];
      }
      let settings: unknown;
      try {
        settings = JSON.parse(row.settings_json) as unknown;
      } catch {
        this.markUnreadableRecord("profile");
        return [];
      }
      const parsed = appProfileSchema.safeParse({
        ...(typeof settings === "object" && settings !== null ? settings : {}),
        id: row.id,
        appId: row.app_id,
        createdAt: row.created_at,
      });
      if (!parsed.success) {
        this.markUnreadableRecord("profile");
        return [];
      }
      return [parsed.data];
    });
  }

  saveProfile(input: Omit<AppProfile, "id" | "createdAt">): AppProfile {
    const now = Date.now();
    const normalizedAppId = sourceApplicationIdSchema.parse(input.appId);
    // Identity lives in dedicated columns and remains usable even when the
    // settings JSON is malformed. Saving the same application repairs that row
    // in place instead of colliding with its UNIQUE app_id and stranding it.
    const existing = (this.db.prepare(
      `SELECT id, app_id, created_at FROM app_profiles
       WHERE app_id = ? COLLATE NOCASE LIMIT 2`,
    ).all(normalizedAppId) as Array<Pick<
      AppProfileRow,
      "id" | "app_id" | "created_at"
    >>).find((row) =>
      typeof row.app_id === "string" && applicationIdsMatch(row.app_id, normalizedAppId),
    );
    if (
      existing
      && (typeof existing.id !== "string" || typeof existing.created_at !== "number")
    ) {
      this.markUnreadableRecord("malformed");
      throw new Error("Stored profile identity metadata is invalid");
    }
    const profile = appProfileSchema.parse({
      ...input,
      appId: normalizedAppId,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.created_at ?? now,
    });
    const { appId, id, createdAt, ...settings } = profile;
    if (existing) {
      this.db
        .prepare("UPDATE app_profiles SET app_id = ?, settings_json = ?, updated_at = ? WHERE id = ?")
        .run(appId, JSON.stringify(settings), now, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO app_profiles (id, app_id, settings_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, appId, JSON.stringify(settings), createdAt, now);
    }
    return profile;
  }

  deleteProfile(id: string): void {
    this.db.prepare("DELETE FROM app_profiles WHERE id = ?").run(id);
  }

  findProfile(appId: string | null): AppProfile | null {
    const normalizedAppId = sanitizeSourceApplicationId(appId);
    if (normalizedAppId === null) return null;
    return this.listProfiles().find((profile) =>
      applicationIdsMatch(profile.appId, normalizedAppId)) ?? null;
  }

  listScratchpadNotes(): ScratchpadNote[] {
    return this.listScratchpadNotesWithIntegrity().items;
  }

  listScratchpadNotesWithIntegrity(): ScratchpadListResult {
    const totalStored = this.countRows("scratchpad_notes");
    const rows = this.db
      .prepare(
        `SELECT id,
           CASE WHEN typeof(body_encrypted) = 'blob' AND length(body_encrypted) <= ?
             THEN body_encrypted ELSE NULL END AS body_encrypted,
           created_at, updated_at
         FROM scratchpad_notes
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(MAX_ENCRYPTED_FIELD_BYTES, MAX_PERSISTED_COLLECTION_ROWS) as ScratchpadNoteRow[];
    const before = this.unreadableRecords;
    const items = rows.flatMap((row) => {
      const body = this.tryDecrypt(row.body_encrypted);
      if (body === null) return [];
      const note = this.buildScratchpadNote(row, body);
      if (note === null) return [];
      return [note];
    });
    const skippedUnreadable = this.unreadableRecords - before;
    return {
      items,
      totalStored,
      skippedUnreadable,
      complete: skippedUnreadable === 0 && rows.length >= totalStored,
    };
  }

  createScratchpadNote(): ScratchpadNote {
    const now = Date.now();
    const note: ScratchpadNote = {
      id: randomUUID(),
      body: "",
      title: "Untitled",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO scratchpad_notes (id, body_encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        note.id,
        this.encryptPersistedPrivateText(note.body, "Scratchpad note"),
        note.createdAt,
        note.updatedAt,
      );
    return note;
  }

  updateScratchpadNote(id: string, body: string): ScratchpadNote {
    const encryptedBody = this.encryptPersistedPrivateText(body, "Scratchpad note");
    const now = Date.now();
    // Validate every returned field before changing the row. A rejected update
    // must leave the old note byte-for-byte intact, including when legacy
    // metadata rather than the new body is malformed.
    const row = this.db
      .prepare("SELECT id, created_at FROM scratchpad_notes WHERE id = ?")
      .get(id) as Pick<ScratchpadNoteRow, "id" | "created_at"> | undefined;
    if (!row) throw new Error("Scratchpad note not found");
    const parsed = scratchpadNoteSchema.safeParse({
      id: row.id,
      body,
      title: deriveScratchpadTitle(body),
      createdAt: row.created_at,
      updatedAt: now,
    });
    if (!parsed.success) throw new Error("Stored scratchpad metadata is invalid");
    const result = this.db
      .prepare(
        `UPDATE scratchpad_notes
         SET body_encrypted = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(encryptedBody, now, id);
    if (result.changes === 0) throw new Error("Scratchpad note not found");
    return parsed.data;
  }

  deleteScratchpadNote(id: string): void {
    this.db.prepare("DELETE FROM scratchpad_notes WHERE id = ?").run(id);
  }

  getSettings(): AppSettings {
    const row = this.db
      .prepare(
        `SELECT CASE WHEN typeof(value_json) = 'text'
           AND length(CAST(value_json AS BLOB)) <= ?
           THEN value_json ELSE NULL END AS value_json
         FROM settings WHERE key = 'app'`,
      )
      .get(MAX_SETTINGS_JSON_BYTES) as { value_json: unknown } | undefined;
    if (!row) return appSettingsSchema.parse(this.defaultSettings);
    if (typeof row.value_json !== "string") {
      throw new Error("Stored settings exceed the safe read limit or have an invalid type");
    }
    return migratePersistedAppSettings(JSON.parse(row.value_json));
  }

  saveSettings(settings: AppSettings): AppSettings {
    const validated = appSettingsSchema.parse(settings);
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(validated), Date.now());
    return validated;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    const supportedVersion = Math.max(...migrations.map((migration) => migration.version));
    const appliedRows = this.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT ?")
      .all(migrations.length + 1) as { version: number }[];
    const futureVersion = appliedRows.find((row) => row.version > supportedVersion)?.version;
    if (futureVersion !== undefined) {
      throw new Error(
        `Database schema ${futureVersion} is newer than supported schema ${supportedVersion}; refusing to modify it.`,
      );
    }
    if (appliedRows.length > migrations.length) {
      throw new Error("Database migration ledger contains more entries than this build supports");
    }
    const applied = new Set(appliedRows.map((row) => row.version));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, Date.now());
      })();
    }
  }

  /**
   * Move dictionary phrases/replacements and snippet triggers out of plaintext.
   *
   * Migration 5 creates staging tables but intentionally leaves the old tables
   * untouched. Encryption must run here, where Electron's OS-backed safeStorage
   * is available. The complete copy, decrypt-after-encrypt verification, table
   * swap, and plaintext-table removal share one SQLite transaction. A failure
   * or process exit therefore leaves the original plaintext rows intact and the
   * next launch can retry; plaintext is never removed before every new field has
   * been verified. Existing encrypted snippet expansions are copied byte-for-byte
   * so an expansion whose old key is temporarily unavailable is not destroyed.
   */
  private migratePrivateTextRules(): void {
    const stagingTables = (this.db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('dictionary_entries_encrypted', 'snippets_encrypted')`,
    ).all() as Array<{ name: string }>).map((row) => row.name);
    if (stagingTables.length === 0) return;
    if (stagingTables.length !== 2) {
      throw new Error("Encrypted text-rule migration is incomplete; refusing to modify user data.");
    }

    const sourceTables = (this.db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('dictionary_entries', 'snippets')`,
    ).all() as Array<{ name: string }>).map((row) => row.name);
    // Narrow legacy repair databases may contain only scratchpad tables. They
    // have no private rules to convert, so remove unused staging rather than
    // inventing data. A partially missing pair is genuine corruption.
    if (sourceTables.length === 0) {
      this.db.exec("DROP TABLE dictionary_entries_encrypted; DROP TABLE snippets_encrypted;");
      return;
    }
    if (sourceTables.length !== 2) {
      throw new Error("Text-rule source tables are incomplete; refusing encrypted migration.");
    }

    const dictionaryRows = this.db.prepare(
      `SELECT id,
         CASE WHEN typeof(phrase) = 'text' AND length(CAST(phrase AS BLOB)) <= ?
           THEN phrase ELSE NULL END AS phrase,
         CASE WHEN typeof(replacement) = 'text' AND length(CAST(replacement AS BLOB)) <= ?
           THEN replacement ELSE NULL END AS replacement,
         created_at, updated_at
       FROM dictionary_entries LIMIT ?`,
    ).all(
      MAX_SETTINGS_JSON_BYTES,
      MAX_SETTINGS_JSON_BYTES,
      MAX_PERSISTED_COLLECTION_ROWS + 1,
    ) as LegacyDictionaryRow[];
    const snippetRows = this.db.prepare(
      `SELECT id,
         CASE WHEN typeof(trigger) = 'text' AND length(CAST(trigger AS BLOB)) <= ?
           THEN trigger ELSE NULL END AS trigger,
         CASE WHEN typeof(expansion_encrypted) = 'blob' AND length(expansion_encrypted) <= ?
           THEN expansion_encrypted ELSE NULL END AS expansion_encrypted,
         created_at, updated_at
       FROM snippets LIMIT ?`,
    ).all(
      MAX_SETTINGS_JSON_BYTES,
      MAX_ENCRYPTED_FIELD_BYTES,
      MAX_PERSISTED_COLLECTION_ROWS + 1,
    ) as LegacySnippetRow[];
    if (
      dictionaryRows.length > MAX_PERSISTED_COLLECTION_ROWS
      || snippetRows.length > MAX_PERSISTED_COLLECTION_ROWS
    ) {
      throw new Error("Legacy text-rule migration exceeds the safe row limit");
    }
    for (const row of dictionaryRows) {
      if (
        row.phrase === null
        || row.replacement === null
        || Buffer.byteLength(row.phrase, "utf8") > MAX_SETTINGS_JSON_BYTES
        || Buffer.byteLength(row.replacement, "utf8") > MAX_SETTINGS_JSON_BYTES
      ) {
        throw new Error("Legacy dictionary migration field exceeds the safe size limit");
      }
    }
    for (const row of snippetRows) {
      if (
        row.trigger === null
        || Buffer.byteLength(row.trigger, "utf8") > MAX_SETTINGS_JSON_BYTES
        || !Buffer.isBuffer(row.expansion_encrypted)
        || row.expansion_encrypted.byteLength > MAX_ENCRYPTED_FIELD_BYTES
      ) {
        throw new Error("Legacy snippet migration field exceeds the safe size limit");
      }
    }

    this.db.transaction(() => {
      this.db.prepare("DELETE FROM dictionary_entries_encrypted").run();
      this.db.prepare("DELETE FROM snippets_encrypted").run();

      const insertDictionary = this.db.prepare(
        `INSERT INTO dictionary_entries_encrypted
           (id, phrase_encrypted, replacement_encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of dictionaryRows) {
        if (row.phrase === null || row.replacement === null) {
          throw new Error("Legacy dictionary migration field is invalid");
        }
        const phraseEncrypted = this.encrypt(row.phrase);
        const replacementEncrypted = this.encrypt(row.replacement);
        if (
          this.decrypt(phraseEncrypted) !== row.phrase
          || this.decrypt(replacementEncrypted) !== row.replacement
        ) {
          throw new Error("OS-backed encryption verification failed during dictionary migration.");
        }
        insertDictionary.run(
          row.id,
          phraseEncrypted,
          replacementEncrypted,
          row.created_at,
          row.updated_at,
        );
      }

      const insertSnippet = this.db.prepare(
        `INSERT INTO snippets_encrypted
           (id, trigger_encrypted, expansion_encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of snippetRows) {
        if (row.trigger === null || row.expansion_encrypted === null) {
          throw new Error("Legacy snippet migration field is invalid");
        }
        const triggerEncrypted = this.encrypt(row.trigger);
        if (this.decrypt(triggerEncrypted) !== row.trigger) {
          throw new Error("OS-backed encryption verification failed during snippet migration.");
        }
        insertSnippet.run(
          row.id,
          triggerEncrypted,
          row.expansion_encrypted,
          row.created_at,
          row.updated_at,
        );
      }

      const migratedDictionaryRows = this.db.prepare(
        `SELECT id, phrase_encrypted, replacement_encrypted
         FROM dictionary_entries_encrypted LIMIT ?`,
      ).all(MAX_PERSISTED_COLLECTION_ROWS + 1) as Array<{
        id: string;
        phrase_encrypted: Buffer;
        replacement_encrypted: Buffer;
      }>;
      const migratedSnippets = this.db.prepare(
        `SELECT id, trigger_encrypted, expansion_encrypted
         FROM snippets_encrypted LIMIT ?`,
      ).all(MAX_PERSISTED_COLLECTION_ROWS + 1) as Array<{
        id: string;
        trigger_encrypted: Buffer;
        expansion_encrypted: Buffer;
      }>;
      if (
        migratedDictionaryRows.length !== dictionaryRows.length
        || migratedSnippets.length !== snippetRows.length
      ) {
        throw new Error("Encrypted text-rule migration row-count verification failed.");
      }
      const oldDictionaryById = new Map(dictionaryRows.map((row) => [row.id, row]));
      for (const row of migratedDictionaryRows) {
        const original = oldDictionaryById.get(row.id);
        if (
          !original
          || this.decrypt(row.phrase_encrypted) !== original.phrase
          || this.decrypt(row.replacement_encrypted) !== original.replacement
        ) {
          throw new Error("Encrypted dictionary migration content verification failed.");
        }
      }
      const oldSnippetById = new Map(snippetRows.map((row) => [row.id, row]));
      for (const row of migratedSnippets) {
        const original = oldSnippetById.get(row.id);
        if (
          !original
          || original.expansion_encrypted === null
          || this.decrypt(row.trigger_encrypted) !== original.trigger
          || !row.expansion_encrypted.equals(original.expansion_encrypted)
        ) {
          throw new Error("Encrypted snippet migration content verification failed.");
        }
      }

      this.db.exec(`
        DROP TABLE dictionary_entries;
        ALTER TABLE dictionary_entries_encrypted RENAME TO dictionary_entries;
        CREATE INDEX idx_dictionary_entries_created_at
          ON dictionary_entries(created_at, id);

        DROP TABLE snippets;
        ALTER TABLE snippets_encrypted RENAME TO snippets;
        CREATE INDEX idx_snippets_created_at
          ON snippets(created_at, id);
      `);
    })();
    // The database is still in constructor-owned single-process startup here.
    // Truncate legacy WAL frames so plaintext copies cannot outlive the atomic
    // table swap in an otherwise-idle sidecar file.
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  /**
   * Persist the field-level settings upgrade once after schema migrations so
   * future reads do not repeatedly depend on a legacy or partially invalid
   * JSON shape.
   */
  private normalizePersistedSettings(): void {
    const row = this.db
      .prepare(
        `SELECT CASE WHEN typeof(value_json) = 'text'
           AND length(CAST(value_json AS BLOB)) <= ?
           THEN value_json ELSE NULL END AS value_json
         FROM settings WHERE key = 'app'`,
      )
      .get(MAX_SETTINGS_JSON_BYTES) as { value_json: unknown } | undefined;
    if (!row) return;
    if (typeof row.value_json !== "string") {
      throw new Error("Stored settings exceed the safe read limit or have an invalid type");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(row.value_json) as unknown;
    } catch {
      // A truncated settings value must not brick the entire desktop app.
      // Preserve the exact unreadable value under a non-active key before
      // replacing only the active settings row with current validated policy
      // defaults. This keeps recovery evidence without repeatedly failing
      // every startup.
      const recovered = this.defaultSettings;
      this.db.transaction(() => {
        this.db
          .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)")
          .run(`app.corrupt.${Date.now()}.${randomUUID()}`, row.value_json, Date.now());
        this.db
          .prepare("UPDATE settings SET value_json = ?, updated_at = ? WHERE key = 'app'")
          .run(JSON.stringify(recovered), Date.now());
      })();
      return;
    }
    const normalized = migratePersistedAppSettings(raw);
    const value = JSON.stringify(normalized);
    if (value === row.value_json) return;
    this.db
      .prepare("UPDATE settings SET value_json = ?, updated_at = ? WHERE key = 'app'")
      .run(value, Date.now());
  }

  private encrypt(value: string): Buffer {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-backed encryption is unavailable; refusing to store private text.");
    }
    return safeStorage.encryptString(value);
  }

  /** Seal only values that this build can read back through its bounded queries. */
  private encryptPersistedPrivateText(value: string, field: string): Buffer {
    const plaintextBytes = Buffer.byteLength(value, "utf8");
    if (plaintextBytes > MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES) {
      throw new Error(
        `${field} exceeds the ${MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES.toLocaleString()}-byte UTF-8 storage limit.`,
      );
    }
    const encrypted = this.encrypt(value);
    if (encrypted.byteLength > MAX_ENCRYPTED_FIELD_BYTES) {
      throw new Error(`${field} encryption exceeds the safe ciphertext storage limit.`);
    }
    return encrypted;
  }

  private decrypt(value: Buffer): string {
    return safeStorage.decryptString(value);
  }

  /**
   * Decrypt a stored field, tolerating a record this install can no longer read.
   *
   * One unreadable row used to throw out of `listTranscriptions`, which blanked
   * the entire history rather than losing one entry — so skipping is right. But
   * skipping silently is its own defect: a history and an *export* both quietly
   * became partial, and there was nothing anywhere to say so. An export that
   * silently omits records is worse than one that fails, because the user keeps
   * it and believes it is complete.
   *
   * So the skip is counted. `unreadableRecordCount()` feeds diagnostics and the
   * affected screens, and `exportTranscriptions` refuses to pretend.
   *
   * Only a decryption failure is tolerated. A `TypeError` or any other
   * programming fault is rethrown: swallowing those was how a code defect could
   * masquerade as user data corruption and silently shrink every list in the
   * app. Rows are never deleted here — unreadable data may become readable
   * again once a keychain entry is restored.
   */
  private tryDecrypt(value: unknown): string | null {
    if (!Buffer.isBuffer(value) || value.byteLength > MAX_ENCRYPTED_FIELD_BYTES) {
      this.markUnreadableRecord("malformed");
      return null;
    }
    try {
      return this.decrypt(value);
    } catch (error) {
      if (!isDecryptionFailure(error)) throw error;
      this.markUnreadableRecord("encrypted");
      return null;
    }
  }

  private markUnreadableRecord(
    kind: "encrypted" | "profile" | "malformed" | "limit",
  ): void {
    this.unreadableRecords += 1;
    // Never log payloads or identifying fields; only the closed record class.
    const message = kind === "encrypted"
      ? "LocalScribe could not decrypt a stored record"
      : kind === "limit"
        ? "LocalScribe bounded an excessive stored collection"
        : `LocalScribe could not read a stored ${kind === "profile" ? "profile " : ""}record`;
    console.warn(message);
  }

  private countRows(
    table: "transcriptions" | "scratchpad_notes",
  ): number {
    const sql = table === "transcriptions"
      ? "SELECT COUNT(*) AS total FROM transcriptions"
      : "SELECT COUNT(*) AS total FROM scratchpad_notes";
    const row = this.db.prepare(sql).get() as { total: unknown };
    if (!Number.isSafeInteger(row.total) || (row.total as number) < 0) {
      throw new Error("Stored collection count is invalid");
    }
    return row.total as number;
  }

  private decodeTranscription(row: TranscriptionRow): Transcription | null {
    const text = this.tryDecrypt(row.text_encrypted);
    if (text === null) return null;
    if (Buffer.byteLength(text, "utf8") > MAX_PERSISTED_PRIVATE_TEXT_UTF8_BYTES) {
      this.markUnreadableRecord("malformed");
      return null;
    }
    const parsed = transcriptionSchema.safeParse({
      id: row.id,
      createdAt: row.created_at,
      durationMs: row.duration_ms,
      text,
      language: row.language,
      modelId: row.model_id,
      status: row.status,
      sourceAppId: sanitizeSourceApplicationId(row.source_app_id),
    });
    if (!parsed.success) {
      this.markUnreadableRecord("malformed");
      return null;
    }
    return parsed.data;
  }

  /**
   * How many stored records this process could not decrypt or validate.
   *
   * Monotonic within a run and counts reads, not distinct rows: the same
   * unreadable row seen by two list calls counts twice. It is a "something is
   * wrong and here is roughly how much" signal for diagnostics, not an
   * inventory.
   */
  unreadableRecordCount(): number {
    return this.unreadableRecords;
  }

  /**
   * Export, with an explicit statement about completeness.
   *
   * The caller must not be able to receive a silently short list, so the count
   * of skipped records travels with the records themselves.
   */
  exportTranscriptionsWithIntegrity(): {
    transcriptions: Transcription[];
    skippedUnreadable: number;
    complete: boolean;
  } {
    const before = this.unreadableRecords;
    const totalStored = this.countRows("transcriptions");
    if (totalStored > MAX_PERSISTED_COLLECTION_ROWS) {
      throw new Error(
        `History export exceeds the safe row limit of ${MAX_PERSISTED_COLLECTION_ROWS.toLocaleString()}.`,
      );
    }
    const transcriptions: Transcription[] = [];
    let plaintextBytes = 0;
    let offset = 0;
    while (offset < totalStored) {
      const rows = this.db.prepare(
        `SELECT id, created_at, duration_ms,
           CASE WHEN typeof(text_encrypted) = 'blob' AND length(text_encrypted) <= ?
             THEN text_encrypted ELSE NULL END AS text_encrypted,
           language, model_id, status, source_app_id
         FROM transcriptions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).all(MAX_ENCRYPTED_FIELD_BYTES, DATABASE_READ_PAGE_SIZE, offset) as TranscriptionRow[];
      for (const row of rows) {
        const transcription = this.decodeTranscription(row);
        if (transcription === null) continue;
        plaintextBytes += Buffer.byteLength(transcription.text, "utf8");
        if (plaintextBytes > MAX_EXPORT_PLAINTEXT_BYTES) {
          throw new Error("History export exceeds the safe plaintext size limit.");
        }
        transcriptions.push(transcription);
      }
      offset += rows.length;
      if (rows.length < DATABASE_READ_PAGE_SIZE) break;
    }
    const skippedUnreadable = this.unreadableRecords - before;
    return {
      transcriptions,
      skippedUnreadable,
      complete: skippedUnreadable === 0 && offset >= totalStored,
    };
  }

  private buildScratchpadNote(row: ScratchpadNoteRow, body: string): ScratchpadNote | null {
    const parsed = scratchpadNoteSchema.safeParse({
      id: row.id,
      body,
      title: deriveScratchpadTitle(body),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    if (!parsed.success) {
      this.markUnreadableRecord("malformed");
      return null;
    }
    return parsed.data;
  }
}

export function deriveScratchpadTitle(body: string): string {
  return body.split(/\r\n?|\n/).find((line) => line.trim().length > 0)?.trim() ?? "Untitled";
}
