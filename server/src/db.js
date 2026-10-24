import Database from 'better-sqlite3';

// Privacy rule: message text and images are never stored. Only a hash of the text (text_hash).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, name TEXT NOT NULL, sign_pub TEXT NOT NULL, ecdh_pub TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS circles (circle_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS circle_members (
  user_id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, joined_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairs (
  pair_id TEXT PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE TABLE IF NOT EXISTS pair_tokens (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS verify_requests (
  request_id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, claimed_id TEXT NOT NULL,
  amount REAL, payment_method TEXT NOT NULL, tier INTEGER NOT NULL,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id TEXT NOT NULL, request_id TEXT NOT NULL,
  impersonated_name TEXT NOT NULL, ts INTEGER NOT NULL
);
`;

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
