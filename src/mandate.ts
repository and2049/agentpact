/**
 * Server-enforced spending mandate. Agents propose; this module decides.
 * Reservation is atomic (one SQLite transaction) and is held while an
 * authorization's outcome is pending or unknown.
 */
import type { Db } from "./db";
import { now } from "./db";

export interface Mandate {
  id: string;
  max_per_pact_cents: number;
  max_aggregate_cents: number;
  allowed_category: string;
  allowed_seller: string;
  reserved_cents: number;
  spent_cents: number;
  owner_id: string | null;
}

/** Wildcard for allowed_category / allowed_seller: the marketplace mandates use it; the demo mandate pins both. */
export const ANY = "*";

export class MandateViolation extends Error {
  constructor(
    public code: "per_pact" | "aggregate" | "category" | "seller" | "missing",
    message: string,
  ) {
    super(message);
  }
}

export function createMandate(
  db: Db,
  m: { id?: string; maxPerPactCents: number; maxAggregateCents: number; allowedCategory: string; allowedSeller: string; ownerId?: string },
): Mandate {
  const id = m.id ?? crypto.randomUUID();
  db.run(
    "INSERT INTO mandates (id, max_per_pact_cents, max_aggregate_cents, allowed_category, allowed_seller, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, m.maxPerPactCents, m.maxAggregateCents, m.allowedCategory, m.allowedSeller, m.ownerId ?? null, now()],
  );
  return getMandate(db, id)!;
}

export function getMandate(db: Db, id: string): Mandate | null {
  return db.query<Mandate, [string]>("SELECT * FROM mandates WHERE id = ?").get(id) ?? null;
}

/** Check and reserve in one transaction. Throws MandateViolation; reserves nothing on failure. */
export function reserve(
  db: Db,
  args: { mandateId: string; pactId: string; amountCents: number; category: string; seller: string },
): Mandate {
  const tx = db.transaction(() => {
    const m = getMandate(db, args.mandateId);
    if (!m) throw new MandateViolation("missing", `mandate ${args.mandateId} not found`);
    if (m.allowed_category !== ANY && args.category !== m.allowed_category) throw new MandateViolation("category", `category ${args.category} not allowed (mandate allows ${m.allowed_category})`);
    if (m.allowed_seller !== ANY && args.seller !== m.allowed_seller) throw new MandateViolation("seller", `seller ${args.seller} not allowed`);
    if (args.amountCents > m.max_per_pact_cents) throw new MandateViolation("per_pact", `${args.amountCents}c exceeds per-pact max ${m.max_per_pact_cents}c`);
    const committed = m.reserved_cents + m.spent_cents + args.amountCents;
    if (committed > m.max_aggregate_cents) throw new MandateViolation("aggregate", `${committed}c would exceed aggregate max ${m.max_aggregate_cents}c`);
    db.run("UPDATE mandates SET reserved_cents = reserved_cents + ? WHERE id = ?", [args.amountCents, m.id]);
    db.run("UPDATE pacts SET reserved_cents = ?, updated_at = ? WHERE id = ?", [args.amountCents, now(), args.pactId]);
    return getMandate(db, m.id)!;
  });
  return tx();
}

/**
 * Settle a reservation: the held amount is released and whatever was actually
 * captured moves to spent. Called only on a confirmed terminal outcome
 * (void, final capture COMPLETED, or confirmed authorization failure).
 */
export function settleReservation(db: Db, args: { mandateId: string; pactId: string; capturedCents: number }): Mandate {
  const tx = db.transaction(() => {
    const pact = db.query<{ reserved_cents: number }, [string]>("SELECT reserved_cents FROM pacts WHERE id = ?").get(args.pactId);
    const held = pact?.reserved_cents ?? 0;
    if (held === 0) return getMandate(db, args.mandateId)!; // already settled; idempotent
    db.run("UPDATE mandates SET reserved_cents = reserved_cents - ?, spent_cents = spent_cents + ? WHERE id = ?", [held, args.capturedCents, args.mandateId]);
    db.run("UPDATE pacts SET reserved_cents = 0, updated_at = ? WHERE id = ?", [now(), args.pactId]);
    return getMandate(db, args.mandateId)!;
  });
  return tx();
}

export function mandateForOwner(db: Db, ownerId: string): Mandate | null {
  return db.query<Mandate, [string]>("SELECT * FROM mandates WHERE owner_id = ? ORDER BY created_at DESC LIMIT 1").get(ownerId) ?? null; // newest: the demo buyer gets a fresh one per day
}

/** Buyer edits the two caps. Neither may drop below what is already committed. */
export function updateMandateCaps(db: Db, id: string, caps: { maxPerPactCents: number; maxAggregateCents: number }): Mandate {
  const tx = db.transaction(() => {
    const m = getMandate(db, id);
    if (!m) throw new MandateViolation("missing", `mandate ${id} not found`);
    if (caps.maxAggregateCents < m.reserved_cents + m.spent_cents) throw new MandateViolation("aggregate", "aggregate cap below committed amount");
    db.run("UPDATE mandates SET max_per_pact_cents = ?, max_aggregate_cents = ? WHERE id = ?", [caps.maxPerPactCents, caps.maxAggregateCents, id]);
    return getMandate(db, id)!;
  });
  return tx();
}
