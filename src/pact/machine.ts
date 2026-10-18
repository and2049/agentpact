/** Job state machine. Transitions are validated here and nowhere else. */
import type { Db } from "../db";
import { appendEvent, now } from "../db";
import { JobSpec, Offer, type PactRow, type PactStatus } from "./types";

const TRANSITIONS: Record<PactStatus, PactStatus[]> = {
  DRAFT: ["OFFERED"],
  OFFERED: ["AGREED", "REJECTED"],
  AGREED: ["HELD", "HOLD_FAILED", "CHECKOUT_EXPIRED"],
  HELD: ["DELIVERED"],
  DELIVERED: ["VERIFIED"],
  VERIFIED: ["SETTLING"],
  SETTLING: ["SETTLED", "SETTLEMENT_FAILED"],
  SETTLED: ["PAID_OUT"],
  SETTLEMENT_FAILED: ["SETTLING"], // operator retry after reconciliation
  PAID_OUT: [],
  REJECTED: [],
  HOLD_FAILED: ["AGREED"], // operator retry
  CHECKOUT_EXPIRED: [],
};

export class IllegalTransition extends Error {
  constructor(
    public from: PactStatus,
    public to: PactStatus,
  ) {
    super(`illegal transition ${from} -> ${to}`);
  }
}

export function canTransition(from: PactStatus, to: PactStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function getPact(db: Db, id: string): PactRow | null {
  return db.query<PactRow, [string]>("SELECT * FROM pacts WHERE id = ?").get(id) ?? null;
}

export function listPacts(db: Db): PactRow[] {
  return db.query<PactRow, []>("SELECT * FROM pacts ORDER BY created_at DESC").all();
}

export function createPact(db: Db, mandateId: string, job: JobSpec): PactRow {
  const parsed = JobSpec.parse(job);
  const id = crypto.randomUUID();
  const ts = now();
  db.run(
    "INSERT INTO pacts (id, mandate_id, status, job_json, item_count, created_at, updated_at) VALUES (?, ?, 'DRAFT', ?, ?, ?, ?)",
    [id, mandateId, JSON.stringify(parsed), parsed.skus.length, ts, ts],
  );
  appendEvent(db, id, "pact.created", { jobId: parsed.id, itemCount: parsed.skus.length });
  return getPact(db, id)!;
}

/**
 * Move a pact to `to`, atomically checking the current status. The optional
 * `set` map writes extra columns in the same statement. Appends an event.
 */
export function transition(db: Db, pactId: string, to: PactStatus, set: Partial<Record<keyof PactRow, unknown>> = {}, eventPayload: unknown = null): PactRow {
  const tx = db.transaction(() => {
    const cur = getPact(db, pactId);
    if (!cur) throw new Error(`pact ${pactId} not found`);
    if (!canTransition(cur.status, to)) throw new IllegalTransition(cur.status, to);
    const cols = Object.keys(set);
    const assignments = ["status = ?", "updated_at = ?", ...cols.map((c) => `${c} = ?`)].join(", ");
    const values: unknown[] = [to, now(), ...cols.map((c) => (set as Record<string, unknown>)[c])];
    db.run(`UPDATE pacts SET ${assignments} WHERE id = ? AND status = ?`, [...values, pactId, cur.status] as never);
    appendEvent(db, pactId, `pact.${to.toLowerCase()}`, eventPayload ?? { from: cur.status, to });
    return getPact(db, pactId)!;
  });
  return tx();
}

export function jobOf(pact: PactRow): JobSpec {
  return JobSpec.parse(JSON.parse(pact.job_json));
}

export function offerOf(pact: PactRow): Offer | null {
  return pact.offer_json ? Offer.parse(JSON.parse(pact.offer_json)) : null;
}

/** Deterministic hash of the frozen agreement. */
export async function pactHash(job: JobSpec, offer: Offer): Promise<string> {
  const canonical = JSON.stringify({ job, offer });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
