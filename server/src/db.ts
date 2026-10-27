import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  presence_visibility TEXT NOT NULL DEFAULT 'friends',
  allow_requests INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS users_name ON users(name_lower);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('premium','device')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_principal ON sessions(principal);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mc_version TEXT NOT NULL,
  loader_kind TEXT NOT NULL,
  loader_version TEXT,
  manifest_json TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  verifier TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked_at INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES keys(id),
  principal TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (key_id, principal)
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  key_id TEXT NOT NULL REFERENCES keys(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (principal, instance_id)
);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  principal TEXT,
  ip_hash TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_uuid TEXT NOT NULL REFERENCES users(uuid),
  to_uuid TEXT NOT NULL REFERENCES users(uuid),
  created_at INTEGER NOT NULL,
  UNIQUE (from_uuid, to_uuid)
);

CREATE TABLE IF NOT EXISTS friendships (
  a TEXT NOT NULL REFERENCES users(uuid),
  b TEXT NOT NULL REFERENCES users(uuid),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker TEXT NOT NULL,
  blocked TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv, sent_at);
CREATE INDEX IF NOT EXISTS messages_unread ON messages(recipient, read_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter TEXT NOT NULL,
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL
);
`;

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', '1')").run();
  return db;
}

/** Transacción con bloqueo de escritura inmediato: garantiza canjes atómicos incluso con varios procesos. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function convId(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
