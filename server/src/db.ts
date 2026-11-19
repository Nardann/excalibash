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
CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS items_owner ON items(owner_id);
CREATE INDEX IF NOT EXISTS grants_user ON grants(user_id);
CREATE INDEX IF NOT EXISTS terminals_board ON terminals(board_id);
CREATE INDEX IF NOT EXISTS terminals_machine ON terminals(machine_id);
PRAGMA user_version = ${SCHEMA_VERSION};
`);

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
