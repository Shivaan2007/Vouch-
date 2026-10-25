import Database from 'better-sqlite3';

// Privacy rule: message text and images are never stored. Only a SHA-256 of the normalized text (text_hash).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, name TEXT NOT NULL, sign_pub TEXT NOT NULL, exch_pub TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairs (
  user_a TEXT NOT NULL, user_b TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);
CREATE TABLE IF NOT EXISTS pair_tokens (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS verify_requests (
  request_id TEXT PRIMARY KEY, checker_id TEXT NOT NULL, claimed_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, method TEXT NOT NULL, channel TEXT NOT NULL, tier INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', payment_risk TEXT NOT NULL DEFAULT 'low',
  explanation TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'rules',
  first_request INTEGER NOT NULL DEFAULT 0, text_hash TEXT, word_ok INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', second_user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL, answer TEXT NOT NULL, ts INTEGER NOT NULL, nonce TEXT NOT NULL UNIQUE,
  sig TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (request_id, role)
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, claimed_id TEXT NOT NULL, request_id TEXT NOT NULL,
  impersonated_name TEXT NOT NULL, ts INTEGER NOT NULL
);
`;

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
