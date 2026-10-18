import { Database } from "bun:sqlite";

export type Db = Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  max_per_pact_cents INTEGER NOT NULL,
  max_aggregate_cents INTEGER NOT NULL,
  allowed_category TEXT NOT NULL,
  allowed_seller TEXT NOT NULL,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pacts (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  status TEXT NOT NULL,
  job_json TEXT NOT NULL,
  offer_json TEXT,
  pact_hash TEXT,
  unit_price_cents INTEGER,
  item_count INTEGER NOT NULL,
  authorized_cents INTEGER,
  accepted_count INTEGER,
  charge_cents INTEGER,
  settlement_kind TEXT,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  pact_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_pact ON events(pact_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  pact_id TEXT PRIMARY KEY,
  body_json TEXT NOT NULL,
  submitted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_verdicts (
  pact_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  score REAL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (pact_id, sku)
);

-- One row per PayPal mutation, written BEFORE the HTTP call. status reflects the
-- HTTP outcome only; provider state lives in the resource tables below.
CREATE TABLE IF NOT EXISTS payment_ops (
  op_id TEXT PRIMARY KEY,
  pact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL,          -- pending | succeeded | failed | unknown
  attempts INTEGER NOT NULL DEFAULT 0,
  resource_id TEXT,
  response_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY,
  pact_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,          -- CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED | DENIED | EXPIRED | PENDING
  expires_at TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  pact_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  final_capture INTEGER NOT NULL,
  status TEXT NOT NULL,          -- PENDING | COMPLETED | DECLINED | FAILED | REFUNDED | PARTIALLY_REFUNDED
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  sender_batch_id TEXT NOT NULL,
  pact_id TEXT NOT NULL,
  receiver TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,          -- PENDING | SUCCESS | FAILED | UNCLAIMED | BLOCKED | RETURNED | ONHOLD | REFUNDED | REVERSED
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  received_at TEXT NOT NULL
);
`;

/** Additive migrations for databases created by earlier versions. */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "pacts", column: "order_id", ddl: "ALTER TABLE pacts ADD COLUMN order_id TEXT" },
  { table: "pacts", column: "checkout_deadline", ddl: "ALTER TABLE pacts ADD COLUMN checkout_deadline TEXT" },
  { table: "pacts", column: "hold_kind", ddl: "ALTER TABLE pacts ADD COLUMN hold_kind TEXT" },
];

export function openDb(path = ":memory:"): Db {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA);
  for (const m of MIGRATIONS) {
    const cols = db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)").all(m.table);
    if (!cols.some((c) => c.name === m.column)) db.run(m.ddl);
  }
  return db;
}

export function now(): string {
  return new Date().toISOString();
}

export function appendEvent(db: Db, pactId: string, type: string, payload: unknown): number {
  const res = db.run(
    "INSERT INTO events (pact_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    [pactId, type, JSON.stringify(payload ?? null), now()],
  );
  return Number(res.lastInsertRowid);
}

export interface EventRow {
  seq: number;
  pact_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export function listEvents(db: Db, pactId: string, afterSeq = 0): EventRow[] {
  return db
    .query<EventRow, [string, number]>("SELECT * FROM events WHERE pact_id = ? AND seq > ? ORDER BY seq")
    .all(pactId, afterSeq);
}
