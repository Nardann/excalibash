import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";

const SCHEMA_VERSION = 2;

mkdirSync(dirname(config.dbPath), { recursive: true });

// Databases from before end-to-end encryption cannot be migrated: their content was never encrypted
// client-side. Keep them aside instead of mixing plaintext with the new model.
if (existsSync(config.dbPath)) {
  const probe = new DatabaseSync(config.dbPath);
  const version = (probe.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const hasTables = !!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get();
  probe.close();
  if (hasTables && version < SCHEMA_VERSION) {
    const backup = `${config.dbPath}.pre-e2e-${Date.now()}.bak`;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(config.dbPath + suffix)) renameSync(config.dbPath + suffix, backup + suffix);
    }
    console.warn(`[db] ancienne base non chiffrée mise de côté : ${backup}`);
  }
}

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  auth_hash TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  public_key TEXT NOT NULL,
  enc_private_key TEXT NOT NULL,
  recovery_enc_private_key TEXT NOT NULL,
  recovery_auth_hash TEXT NOT NULL,
  enc_vault TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  expires_at INTEGER NOT NULL,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'board')),
  parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  enc_name TEXT NOT NULL,
  key_wrap TEXT,
  key_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS grants (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  wrapped_key TEXT NOT NULL,
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  elements TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '{}',
  preview TEXT
);
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enc_name TEXT NOT NULL,
  enc_pub TEXT NOT NULL,
  enc_auth TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  hostname TEXT,
  os TEXT,
  arch TEXT,
  last_seen INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  key_for_board TEXT NOT NULL,
  key_for_agent TEXT NOT NULL,
  enc_label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  key_for_board TEXT NOT NULL,
  key_for_agent TEXT NOT NULL,
  enc_label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tunnels_board ON tunnels(board_id);
CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS items_owner ON items(owner_id);
CREATE INDEX IF NOT EXISTS grants_user ON grants(user_id);
CREATE INDEX IF NOT EXISTS terminals_board ON terminals(board_id);
CREATE INDEX IF NOT EXISTS terminals_machine ON terminals(machine_id);
PRAGMA user_version = ${SCHEMA_VERSION};
`);

// v2 databases created before machines carried an owner-only auth key.
if (!(db.prepare("PRAGMA table_info(machines)").all() as { name: string }[]).some((c) => c.name === "enc_auth")) {
  db.exec("ALTER TABLE machines ADD COLUMN enc_auth TEXT");
}
// Personal Excalidraw library, encrypted under the owner's vault key.
if (!(db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "enc_library")) {
  db.exec("ALTER TABLE users ADD COLUMN enc_library TEXT");
}

/** Adds a column to an existing table if it is missing (lightweight migrations). */
function addColumn(table: string, column: string, ddl: string, backfill?: string) {
  if ((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  if (backfill) db.exec(backfill);
}

// Registration, verification and administration.
addColumn("users", "email_verified", "INTEGER NOT NULL DEFAULT 1"); // accounts from before verification count as verified
addColumn("users", "verify_code_hash", "TEXT");
addColumn("users", "verify_expires", "INTEGER");
addColumn("users", "verify_attempts", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "suspended", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "last_seen_at", "INTEGER");
addColumn("users", "onboarded", "INTEGER NOT NULL DEFAULT 0", "UPDATE users SET onboarded = 1"); // existing users skip the guide
addColumn("users", "discoverable", "INTEGER NOT NULL DEFAULT 1"); // legacy, no longer read
addColumn("users", "findable_name", "INTEGER NOT NULL DEFAULT 1");
addColumn("users", "findable_email", "INTEGER NOT NULL DEFAULT 0");

export function newId(bytes = 12): string {
  return randomBytes(bytes).toString("base64url");
}

/** Client-generated ids (bound into ciphertext AADs). */
export const isClientId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{16,43}$/.test(v);

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function serverSecret(): string {
  let s = getSetting("server_secret", "");
  if (!s) {
    s = randomBytes(32).toString("base64url");
    setSetting("server_secret", s);
  }
  return s;
}

/** Runs fn inside a transaction. */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
