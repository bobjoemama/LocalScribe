export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "local_first_core",
    sql: `
      CREATE TABLE transcriptions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        text_encrypted BLOB NOT NULL,
        language TEXT,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('complete', 'failed')),
        source_app_id TEXT
      );

      CREATE INDEX idx_transcriptions_created_at
        ON transcriptions(created_at DESC);

      CREATE TABLE dictionary_entries (
        id TEXT PRIMARY KEY,
        phrase TEXT NOT NULL COLLATE NOCASE UNIQUE,
        replacement TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE snippets (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL COLLATE NOCASE UNIQUE,
        expansion_encrypted BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE app_profiles (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL UNIQUE,
        settings_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE model_installations (
        model_id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        sha256 TEXT,
        local_path TEXT,
        state TEXT NOT NULL,
        installed_at INTEGER
      );
    `,
  },
  {
    version: 2,
    name: "encrypted_scratchpad",
    sql: `
      CREATE TABLE scratchpad (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        body_encrypted BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "encrypted_multi_note_scratchpad",
    sql: `
      CREATE TABLE scratchpad_notes (
        id TEXT PRIMARY KEY,
        body_encrypted BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX idx_scratchpad_notes_updated_at
        ON scratchpad_notes(updated_at DESC, id DESC);

      INSERT INTO scratchpad_notes (id, body_encrypted, created_at, updated_at)
      SELECT
        '00000000-0000-4000-8000-000000000001',
        body_encrypted,
        updated_at,
        updated_at
      FROM scratchpad
      WHERE id = 1;
    `,
  },
  {
    version: 4,
    name: "remove_legacy_scratchpad",
    sql: `
      DROP TABLE IF EXISTS scratchpad;
    `,
  },
];
