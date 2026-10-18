/** Provider-status rows for authorizations, captures and payout items. */
import type { Db } from "../db";
import { now } from "../db";
import { amountToCents } from "../money";
import type { Authorization, Capture, PayoutBatch, PayoutItem } from "../paypal/client";

export interface AuthorizationRow {
  id: string;
  pact_id: string;
  order_id: string;
  amount_cents: number;
  status: string;
  expires_at: string | null;
}

export interface CaptureRow {
  id: string;
  pact_id: string;
  authorization_id: string;
  amount_cents: number;
  final_capture: number;
  status: string;
}

export interface PayoutRow {
  item_id: string;
  batch_id: string;
  sender_batch_id: string;
  pact_id: string;
  receiver: string;
  amount_cents: number;
  status: string;
}

export function recordAuthorization(db: Db, pactId: string, orderId: string, auth: Authorization): AuthorizationRow {
  db.run(
    `INSERT INTO authorizations (id, pact_id, order_id, amount_cents, status, expires_at, raw_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at, raw_json = excluded.raw_json, updated_at = excluded.updated_at`,
    [auth.id, pactId, orderId, amountToCents(auth.amount.value), auth.status, auth.expiration_time ?? null, JSON.stringify(auth), now()],
  );
  return getAuthorization(db, auth.id)!;
}

export function getAuthorization(db: Db, id: string): AuthorizationRow | null {
  return db.query<AuthorizationRow, [string]>("SELECT * FROM authorizations WHERE id = ?").get(id) ?? null;
}

export function authorizationForPact(db: Db, pactId: string): AuthorizationRow | null {
  return db.query<AuthorizationRow, [string]>("SELECT * FROM authorizations WHERE pact_id = ? ORDER BY updated_at DESC LIMIT 1").get(pactId) ?? null;
}

export function recordCapture(db: Db, pactId: string, authorizationId: string, cap: Capture): CaptureRow {
  db.run(
    `INSERT INTO captures (id, pact_id, authorization_id, amount_cents, final_capture, status, raw_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, raw_json = excluded.raw_json, updated_at = excluded.updated_at`,
    [cap.id, pactId, authorizationId, amountToCents(cap.amount.value), cap.final_capture ? 1 : 0, cap.status, JSON.stringify(cap), now()],
  );
  return getCapture(db, cap.id)!;
}

export function getCapture(db: Db, id: string): CaptureRow | null {
  return db.query<CaptureRow, [string]>("SELECT * FROM captures WHERE id = ?").get(id) ?? null;
}

export function captureForPact(db: Db, pactId: string): CaptureRow | null {
  return db.query<CaptureRow, [string]>("SELECT * FROM captures WHERE pact_id = ? ORDER BY updated_at DESC LIMIT 1").get(pactId) ?? null;
}

export function recordPayoutItems(db: Db, pactId: string, batch: PayoutBatch): PayoutRow[] {
  const rows: PayoutRow[] = [];
  for (const item of batch.items ?? []) {
    rows.push(recordPayoutItem(db, pactId, batch.batch_header.sender_batch_header.sender_batch_id, item));
  }
  return rows;
}

export function recordPayoutItem(db: Db, pactId: string, senderBatchId: string, item: PayoutItem): PayoutRow {
  db.run(
    `INSERT INTO payouts (item_id, batch_id, sender_batch_id, pact_id, receiver, amount_cents, status, raw_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, raw_json = excluded.raw_json, updated_at = excluded.updated_at`,
    [
      item.payout_item_id,
      item.payout_batch_id,
      senderBatchId,
      pactId,
      item.payout_item.receiver,
      amountToCents(item.payout_item.amount.value),
      item.transaction_status,
      JSON.stringify(item),
      now(),
    ],
  );
  return db.query<PayoutRow, [string]>("SELECT * FROM payouts WHERE item_id = ?").get(item.payout_item_id)!;
}

export function payoutForPact(db: Db, pactId: string): PayoutRow | null {
  return db.query<PayoutRow, [string]>("SELECT * FROM payouts WHERE pact_id = ? ORDER BY updated_at DESC LIMIT 1").get(pactId) ?? null;
}
