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
  {
    version: 5,
    name: "stage_encrypted_text_rules",
    sql: `
      CREATE TABLE dictionary_entries_encrypted (
        id TEXT PRIMARY KEY,
        phrase_encrypted BLOB NOT NULL,
        replacement_encrypted BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE snippets_encrypted (
        id TEXT PRIMARY KEY,
        trigger_encrypted BLOB NOT NULL,
        expansion_encrypted BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "canonical_application_identities",
    sql: `
      -- Some narrow recovery fixtures legitimately contain only scratchpad
      -- tables despite carrying the v1 ledger entry. Recreate the two tables
      -- this migration owns when they are absent so that recovery remains
      -- forward-compatible without weakening a normal database.
      CREATE TABLE IF NOT EXISTS transcriptions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        text_encrypted BLOB NOT NULL,
        language TEXT,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('complete', 'failed')),
        source_app_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at
        ON transcriptions(created_at DESC);

      -- History may contain an executable path emitted by a legacy native
      -- helper. Retain only bounded reverse-DNS-like identifiers and
      -- canonicalize them; private transcript text and all other metadata stay
      -- untouched.
      UPDATE transcriptions
      SET source_app_id = CASE
        WHEN typeof(source_app_id) = 'text'
          AND length(trim(source_app_id)) BETWEEN 3 AND 300
          AND instr(trim(source_app_id), '.') > 1
          AND substr(trim(source_app_id), 1, 1) <> '.'
          AND substr(trim(source_app_id), -1, 1) <> '.'
          AND instr(trim(source_app_id), '..') = 0
          AND trim(source_app_id) NOT GLOB '*[^A-Za-z0-9.-]*'
        THEN lower(trim(source_app_id))
        ELSE NULL
      END
      WHERE source_app_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS app_profiles (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL UNIQUE,
        settings_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE app_profiles_case_insensitive (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (
          length(app_id) BETWEEN 3 AND 300
          AND instr(app_id, '.') > 1
          AND substr(app_id, 1, 1) <> '.'
          AND substr(app_id, -1, 1) <> '.'
          AND instr(app_id, '..') = 0
          AND app_id NOT GLOB '*[^A-Za-z0-9.-]*'
        ),
        settings_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Invalid legacy identities and superseded case variants remain
      -- recoverable byte-for-byte instead of being discarded by the active
      -- profile rebuild.
      CREATE TABLE app_profiles_identity_recovery (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('invalid_identity', 'case_duplicate'))
      );

      WITH classified AS (
        SELECT
          rowid AS legacy_rowid,
          id,
          app_id,
          settings_json,
          created_at,
          updated_at,
          CASE WHEN
            typeof(app_id) = 'text'
            AND length(trim(app_id)) BETWEEN 3 AND 300
            AND instr(trim(app_id), '.') > 1
            AND substr(trim(app_id), 1, 1) <> '.'
            AND substr(trim(app_id), -1, 1) <> '.'
            AND instr(trim(app_id), '..') = 0
            AND trim(app_id) NOT GLOB '*[^A-Za-z0-9.-]*'
          THEN 1 ELSE 0 END AS valid_identity,
          CASE WHEN
            typeof(app_id) = 'text'
            AND length(trim(app_id)) BETWEEN 3 AND 300
            AND instr(trim(app_id), '.') > 1
            AND substr(trim(app_id), 1, 1) <> '.'
            AND substr(trim(app_id), -1, 1) <> '.'
            AND instr(trim(app_id), '..') = 0
            AND trim(app_id) NOT GLOB '*[^A-Za-z0-9.-]*'
          THEN lower(trim(app_id)) ELSE id END AS identity_key
        FROM app_profiles
      ), ranked AS (
        SELECT classified.*, row_number() OVER (
          PARTITION BY valid_identity, identity_key
          ORDER BY updated_at DESC, created_at DESC, id COLLATE BINARY ASC, legacy_rowid ASC
        ) AS identity_rank
        FROM classified
      )
      INSERT INTO app_profiles_identity_recovery
        (id, app_id, settings_json, created_at, updated_at, reason)
      SELECT
        id,
        app_id,
        settings_json,
        created_at,
        updated_at,
        CASE WHEN valid_identity = 0 THEN 'invalid_identity' ELSE 'case_duplicate' END
      FROM ranked
      WHERE valid_identity = 0 OR identity_rank > 1;

      -- The most recently updated valid row is the user's latest
      -- configuration. The remaining tie-breakers make the survivor
      -- independent of query order.
      WITH classified AS (
        SELECT
          rowid AS legacy_rowid,
          id,
          lower(trim(app_id)) AS canonical_app_id,
          settings_json,
          created_at,
          updated_at
        FROM app_profiles
        WHERE typeof(app_id) = 'text'
          AND length(trim(app_id)) BETWEEN 3 AND 300
          AND instr(trim(app_id), '.') > 1
          AND substr(trim(app_id), 1, 1) <> '.'
          AND substr(trim(app_id), -1, 1) <> '.'
          AND instr(trim(app_id), '..') = 0
          AND trim(app_id) NOT GLOB '*[^A-Za-z0-9.-]*'
      ), ranked AS (
        SELECT classified.*, row_number() OVER (
          PARTITION BY canonical_app_id
          ORDER BY updated_at DESC, created_at DESC, id COLLATE BINARY ASC, legacy_rowid ASC
        ) AS identity_rank
        FROM classified
      )
      INSERT INTO app_profiles_case_insensitive
        (id, app_id, settings_json, created_at, updated_at)
      SELECT
        id,
        canonical_app_id,
        settings_json,
        created_at,
        updated_at
      FROM ranked
      WHERE identity_rank = 1;

      DROP TABLE app_profiles;
      ALTER TABLE app_profiles_case_insensitive RENAME TO app_profiles;
    `,
  },
];
