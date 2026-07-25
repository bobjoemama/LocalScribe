import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { safeStorage } from "electron";
import {
  DEFAULT_SETTINGS,
  MAX_HISTORY_ITEMS,
  appSettingsSchema,
  migratePersistedAppSettings,
  type AppSettings,
  type AppProfile,
  type DictionaryEntry,
  type ScratchpadNote,
  type Snippet,
  type Transcription,
} from "../../shared/contracts";
import { applicationIdsMatch, normalizeApplicationId } from "../../shared/appIdentity";
import { migrations } from "./migrations";

interface TranscriptionRow {
  id: string;
  created_at: number;
  duration_ms: number;
  text_encrypted: Buffer;
  language: string | null;
  model_id: string;
  status: "complete" | "failed";
  source_app_id: string | null;
}

interface DictionaryRow {
  id: string;
  phrase: string;
  replacement: string;
  created_at: number;
}

interface SnippetRow {
  id: string;
  trigger: string;
  expansion_encrypted: Buffer;
  created_at: number;
}

interface AppProfileRow {
  id: string;
  app_id: string;
  settings_json: string;
  created_at: number;
}

interface ScratchpadNoteRow {
  id: string;
  body_encrypted: Buffer;
  created_at: number;
  updated_at: number;
}

const USER_ONLY_DIRECTORY_MODE = 0o700;
const USER_ONLY_FILE_MODE = 0o600;

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
  if (process.platform === "win32" || databasePath === ":memory:") return;

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

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
    this.normalizePersistedSettings();
    hardenDatabasePermissions(path);
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
    const rows = this.db
      .prepare("SELECT * FROM transcriptions ORDER BY created_at DESC LIMIT ?")
      .all(bounded) as TranscriptionRow[];
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      durationMs: row.duration_ms,
      text: this.decrypt(row.text_encrypted),
      language: row.language,
      modelId: row.model_id,
      status: row.status,
      sourceAppId: row.source_app_id,
    }));
  }

  exportTranscriptions(): Transcription[] {
    const rows = this.db
      .prepare("SELECT * FROM transcriptions ORDER BY created_at DESC")
      .all() as TranscriptionRow[];
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      durationMs: row.duration_ms,
      text: this.decrypt(row.text_encrypted),
      language: row.language,
      modelId: row.model_id,
      status: row.status,
      sourceAppId: row.source_app_id,
    }));
  }

  saveTranscription(input: Omit<Transcription, "id" | "createdAt">): Transcription {
    const result: Transcription = {
      ...input,
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
        this.encrypt(result.text),
        result.language,
        result.modelId,
        result.status,
        result.sourceAppId ?? null,
      );
    return result;
  }

  deleteTranscription(id: string): void {
    this.db.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);
  }

  clearTranscriptions(): void {
    this.db.prepare("DELETE FROM transcriptions").run();
  }

  purgeExpiredTranscriptions(retentionDays: AppSettings["historyRetentionDays"]): number {
    if (retentionDays === 0) return 0;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    return this.db.prepare("DELETE FROM transcriptions WHERE created_at < ?").run(cutoff).changes;
  }

  listDictionary(): DictionaryEntry[] {
    const rows = this.db
      .prepare("SELECT id, phrase, replacement, created_at FROM dictionary_entries ORDER BY phrase")
      .all() as DictionaryRow[];
    return rows.map((row) => ({
      id: row.id,
      phrase: row.phrase,
      replacement: row.replacement,
      createdAt: row.created_at,
    }));
  }

  saveDictionary(input: Pick<DictionaryEntry, "phrase" | "replacement">): DictionaryEntry {
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT id, created_at FROM dictionary_entries WHERE phrase = ? COLLATE NOCASE")
      .get(input.phrase) as { id: string; created_at: number } | undefined;
    const entry: DictionaryEntry = {
      id: existing?.id ?? randomUUID(),
      phrase: input.phrase,
      replacement: input.replacement,
      createdAt: existing?.created_at ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO dictionary_entries (id, phrase, replacement, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(phrase) DO UPDATE SET replacement = excluded.replacement, updated_at = excluded.updated_at`,
      )
      .run(entry.id, entry.phrase, entry.replacement, entry.createdAt, now);
    return entry;
  }

  deleteDictionary(id: string): void {
    this.db.prepare("DELETE FROM dictionary_entries WHERE id = ?").run(id);
  }

  listSnippets(): Snippet[] {
    const rows = this.db
      .prepare("SELECT id, trigger, expansion_encrypted, created_at FROM snippets ORDER BY trigger")
      .all() as SnippetRow[];
    return rows.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      expansion: this.decrypt(row.expansion_encrypted),
      createdAt: row.created_at,
    }));
  }

  saveSnippet(input: Pick<Snippet, "trigger" | "expansion">): Snippet {
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT id, created_at FROM snippets WHERE trigger = ? COLLATE NOCASE")
      .get(input.trigger) as { id: string; created_at: number } | undefined;
    const snippet: Snippet = {
      id: existing?.id ?? randomUUID(),
      trigger: input.trigger,
      expansion: input.expansion,
      createdAt: existing?.created_at ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO snippets (id, trigger, expansion_encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(trigger) DO UPDATE SET expansion_encrypted = excluded.expansion_encrypted, updated_at = excluded.updated_at`,
      )
      .run(snippet.id, snippet.trigger, this.encrypt(snippet.expansion), snippet.createdAt, now);
    return snippet;
  }

  deleteSnippet(id: string): void {
    this.db.prepare("DELETE FROM snippets WHERE id = ?").run(id);
  }

  listProfiles(): AppProfile[] {
    const rows = this.db
      .prepare("SELECT id, app_id, settings_json, created_at FROM app_profiles ORDER BY app_id")
      .all() as AppProfileRow[];
    return rows.map((row) => ({
      id: row.id,
      appId: row.app_id,
      createdAt: row.created_at,
      ...(JSON.parse(row.settings_json) as Omit<AppProfile, "id" | "appId" | "createdAt">),
    }));
  }

  saveProfile(input: Omit<AppProfile, "id" | "createdAt">): AppProfile {
    const now = Date.now();
    const normalizedAppId = normalizeApplicationId(input.appId);
    const existing = this.listProfiles().find((profile) =>
      applicationIdsMatch(profile.appId, normalizedAppId),
    );
    const profile: AppProfile = {
      ...input,
      appId: normalizedAppId,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
    };
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
    if (!appId) return null;
    return this.listProfiles().find((profile) => applicationIdsMatch(profile.appId, appId)) ?? null;
  }

  listScratchpadNotes(): ScratchpadNote[] {
    const rows = this.db
      .prepare(
        `SELECT id, body_encrypted, created_at, updated_at
         FROM scratchpad_notes
         ORDER BY updated_at DESC, id DESC`,
      )
      .all() as ScratchpadNoteRow[];
    return rows.map((row) => this.toScratchpadNote(row));
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
      .run(note.id, this.encrypt(note.body), note.createdAt, note.updatedAt);
    return note;
  }

  updateScratchpadNote(id: string, body: string): ScratchpadNote {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE scratchpad_notes
         SET body_encrypted = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(this.encrypt(body), now, id);
    if (result.changes === 0) throw new Error("Scratchpad note not found");

    const row = this.db
      .prepare(
        `SELECT id, body_encrypted, created_at, updated_at
         FROM scratchpad_notes
         WHERE id = ?`,
      )
      .get(id) as ScratchpadNoteRow;
    return this.toScratchpadNote(row);
  }

  deleteScratchpadNote(id: string): void {
    this.db.prepare("DELETE FROM scratchpad_notes WHERE id = ?").run(id);
  }

  getSettings(): AppSettings {
    const row = this.db
      .prepare("SELECT value_json FROM settings WHERE key = 'app'")
      .get() as { value_json: string } | undefined;
    return row
      ? migratePersistedAppSettings(JSON.parse(row.value_json))
      : appSettingsSchema.parse(DEFAULT_SETTINGS);
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
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
        (row) => row.version,
      ),
    );
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
   * Persist the field-level settings upgrade once after schema migrations so
   * future reads do not repeatedly depend on a legacy or partially invalid
   * JSON shape.
   */
  private normalizePersistedSettings(): void {
    const row = this.db
      .prepare("SELECT value_json FROM settings WHERE key = 'app'")
      .get() as { value_json: string } | undefined;
    if (!row) return;
    let raw: unknown;
    try {
      raw = JSON.parse(row.value_json) as unknown;
    } catch {
      // A truncated settings value must not brick the entire desktop app.
      // Preserve the exact unreadable value under a non-active key before
      // replacing only the active settings row with current validated policy
      // defaults. This keeps recovery evidence without repeatedly failing
      // every startup.
      const recovered = appSettingsSchema.parse(DEFAULT_SETTINGS);
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

  private decrypt(value: Buffer): string {
    return safeStorage.decryptString(value);
  }

  private toScratchpadNote(row: ScratchpadNoteRow): ScratchpadNote {
    const body = this.decrypt(row.body_encrypted);
    return {
      id: row.id,
      body,
      title: deriveScratchpadTitle(body),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export function deriveScratchpadTitle(body: string): string {
  return body.split(/\r\n?|\n/).find((line) => line.trim().length > 0)?.trim() ?? "Untitled";
}
