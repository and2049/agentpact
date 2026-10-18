/**
 * Payment operations log. Every PayPal mutation gets a row BEFORE the HTTP call.
 * The row's status is the HTTP outcome only (pending/succeeded/failed/unknown);
 * provider state (CREATED/COMPLETED/...) lives in the resource tables.
 *
 * Retrying an op with the same opId reuses the same PayPal-Request-Id, so a
 * timeout-after-success is resolved by PayPal's own idempotency: the replay
 * returns the original resource instead of creating a second one.
 */
import type { Db } from "../db";
import { now } from "../db";
import { PayPalHttpError, PayPalTransportError } from "../paypal/client";

export type OpStatus = "pending" | "succeeded" | "failed" | "unknown";

export interface OpRow {
  op_id: string;
  pact_id: string;
  kind: string;
  request_id: string;
  status: OpStatus;
  attempts: number;
  resource_id: string | null;
  response_json: string | null;
  error_text: string | null;
}

export type OpResult<T> =
  | { status: "succeeded"; result: T; replayed: boolean }
  | { status: "failed"; error: PayPalHttpError }
  | { status: "unknown"; error: Error };

export interface OpSpec<T> {
  db: Db;
  pactId: string;
  kind: string;
  /** Stable per logical operation (e.g. `${pactId}:capture`). Same opId => same request id. */
  opId: string;
  call: (requestId: string) => Promise<T>;
  resourceIdOf: (result: T) => string;
}

export function getOp(db: Db, opId: string): OpRow | null {
  return db.query<OpRow, [string]>("SELECT * FROM payment_ops WHERE op_id = ?").get(opId) ?? null;
}

export async function runOp<T>(spec: OpSpec<T>): Promise<OpResult<T>> {
  const { db, opId } = spec;
  const existing = getOp(db, opId);
  if (existing?.status === "succeeded" && existing.response_json) {
    return { status: "succeeded", result: JSON.parse(existing.response_json) as T, replayed: true };
  }
  let requestId: string;
  const ts = now();
  if (existing) {
    requestId = existing.request_id;
    db.run("UPDATE payment_ops SET status = 'pending', attempts = attempts + 1, updated_at = ? WHERE op_id = ?", [ts, opId]);
  } else {
    requestId = crypto.randomUUID();
    db.run(
      "INSERT INTO payment_ops (op_id, pact_id, kind, request_id, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)",
      [opId, spec.pactId, spec.kind, requestId, ts, ts],
    );
  }

  try {
    const result = await spec.call(requestId);
    db.run("UPDATE payment_ops SET status = 'succeeded', resource_id = ?, response_json = ?, error_text = NULL, updated_at = ? WHERE op_id = ?", [
      spec.resourceIdOf(result),
      JSON.stringify(result),
      now(),
      opId,
    ]);
    return { status: "succeeded", result, replayed: false };
  } catch (e) {
    if (e instanceof PayPalHttpError) {
      db.run("UPDATE payment_ops SET status = 'failed', response_json = ?, error_text = ?, updated_at = ? WHERE op_id = ?", [
        JSON.stringify(e.body ?? null),
        e.message,
        now(),
        opId,
      ]);
      return { status: "failed", error: e };
    }
    const err = e instanceof PayPalTransportError ? e : new PayPalTransportError((e as Error).message);
    db.run("UPDATE payment_ops SET status = 'unknown', error_text = ?, updated_at = ? WHERE op_id = ?", [err.message, now(), opId]);
    return { status: "unknown", error: err };
  }
}

export function listOps(db: Db, pactId: string): OpRow[] {
  return db.query<OpRow, [string]>("SELECT * FROM payment_ops WHERE pact_id = ? ORDER BY created_at").all(pactId);
}
