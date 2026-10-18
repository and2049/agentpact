/**
 * Real-buyer hold path (validated by spike (a), 2026-10-18):
 *
 *   beginCheckout   AGREED  -> reserve mandate, op create_order (approval order),
 *                              store order_id + deadline; pact stays AGREED
 *   completeCheckout AGREED -> after buyer approval: verify ownership of the order id,
 *                              read the order (APPROVED, amount, currency), op authorize,
 *                              record authorization -> HELD only if status CREATED
 *   expireCheckouts  AGREED -> deadline passed, no authorization: CHECKOUT_EXPIRED,
 *                              reservation released; later approvals are rejected
 *
 * Approval is not a hold. Creation and authorization are separate idempotent ops.
 */
import { appendEvent, now } from "../db";
import { MandateViolation, reserve, settleReservation } from "../mandate";
import { getPact, jobOf, transition } from "../pact/machine";
import type { PactRow } from "../pact/types";
import { amountToCents } from "../money";
import type { FlowDeps } from "./flow";
import { getOp, runOp } from "./ops";
import { authorizationForPact, recordAuthorization } from "./resources";

export const CHECKOUT_TTL_MS = 30 * 60 * 1000;

export type CheckoutResult =
  | { ok: true; pact: PactRow }
  | { ok: false; code: "state" | "ownership" | "expired" | "not_approved" | "mismatch" | "unknown" | "failed" | "mandate"; message: string; pact: PactRow | null };

export async function beginCheckout(deps: FlowDeps, pactId: string, ttlMs = CHECKOUT_TTL_MS): Promise<CheckoutResult> {
  const { db, paypal } = deps;
  const pact = getPact(db, pactId);
  if (!pact) return { ok: false, code: "state", message: "pact not found", pact: null };
  if (pact.status !== "AGREED") return { ok: false, code: "state", message: `cannot begin checkout from ${pact.status}`, pact };
  if (pact.order_id) return { ok: true, pact }; // idempotent
  if (!pact.unit_price_cents) return { ok: false, code: "state", message: "pact has no unit price", pact };
  const job = jobOf(pact);
  const amountCents = pact.unit_price_cents * pact.item_count;

  if (pact.reserved_cents === 0) {
    try {
      reserve(db, { mandateId: pact.mandate_id, pactId, amountCents, category: job.category, seller: job.seller });
      appendEvent(db, pactId, "mandate.reserved", { amountCents });
    } catch (e) {
      if (e instanceof MandateViolation) {
        appendEvent(db, pactId, "mandate.violation", { code: e.code, message: e.message });
        return { ok: false, code: "mandate", message: e.message, pact: transition(db, pactId, "HOLD_FAILED", {}, { reason: e.message }) };
      }
      throw e;
    }
  }

  const op = await runOp({
    db,
    pactId,
    kind: "create_order_checkout",
    opId: `${pactId}:checkout-order`,
    call: (requestId) => paypal.createApprovalOrder({ requestId, amountCents, customId: pactId, referenceId: pactId.slice(0, 8) }),
    resourceIdOf: (o) => o.id,
  });
  if (op.status === "unknown") {
    appendEvent(db, pactId, "checkout.unknown", { error: op.error.message });
    return { ok: false, code: "unknown", message: "order creation outcome unknown; retry", pact: getPact(db, pactId) };
  }
  if (op.status === "failed") {
    appendEvent(db, pactId, "checkout.failed", { status: op.error.status, body: op.error.body });
    settleReservation(db, { mandateId: pact.mandate_id, pactId, capturedCents: 0 });
    return { ok: false, code: "failed", message: `order creation failed (${op.error.status})`, pact: transition(db, pactId, "HOLD_FAILED", {}, { httpStatus: op.error.status }) };
  }
  const deadline = new Date(Date.now() + ttlMs).toISOString();
  // authorized_cents stays unset until a usable authorization is recorded (approval is not a hold).
  db.run("UPDATE pacts SET order_id = ?, checkout_deadline = ?, hold_kind = 'checkout', updated_at = ? WHERE id = ? AND status = 'AGREED'", [op.result.id, deadline, now(), pactId]);
  appendEvent(db, pactId, "checkout.order_created", { orderId: op.result.id, amountCents, deadline, replayed: op.replayed });
  return { ok: true, pact: getPact(db, pactId)! };
}

export async function completeCheckout(deps: FlowDeps, pactId: string, orderId: string): Promise<CheckoutResult> {
  const { db, paypal } = deps;
  const pact = getPact(db, pactId);
  if (!pact) return { ok: false, code: "state", message: "pact not found", pact: null };
  if (pact.status === "HELD" && pact.order_id === orderId) return { ok: true, pact }; // idempotent
  if (pact.status !== "AGREED") return { ok: false, code: "state", message: `cannot complete checkout from ${pact.status}`, pact };
  if (!pact.order_id || pact.order_id !== orderId) {
    appendEvent(db, pactId, "checkout.order_mismatch", { posted: orderId });
    return { ok: false, code: "ownership", message: "order id does not belong to this pact", pact };
  }
  if (pact.checkout_deadline && pact.checkout_deadline < now() && !getOp(db, `${pactId}:authorize`)) {
    return { ok: false, code: "expired", message: "checkout deadline passed", pact };
  }

  // Server-side truth about the order before spending an authorize call.
  let order: Awaited<ReturnType<typeof paypal.getOrder>>;
  try {
    order = await paypal.getOrder(orderId);
  } catch (e) {
    return { ok: false, code: "unknown", message: `could not read order: ${(e as Error).message}`, pact };
  }
  const pu = order.purchase_units[0];
  const expected = (pact.unit_price_cents ?? 0) * pact.item_count; // frozen price × items
  if (!pu || pu.amount.currency_code !== "USD" || amountToCents(pu.amount.value) !== expected || pu.custom_id !== pactId) {
    appendEvent(db, pactId, "checkout.amount_mismatch", { orderId, amount: pu?.amount, expected });
    return { ok: false, code: "mismatch", message: "order amount or association does not match the pact", pact };
  }
  const existingAuth = pu.payments?.authorizations?.[0];
  if (order.status !== "APPROVED" && order.status !== "COMPLETED") {
    return { ok: false, code: "not_approved", message: `order status is ${order.status}`, pact };
  }

  let auth = existingAuth;
  if (!auth) {
    const op = await runOp({
      db,
      pactId,
      kind: "authorize_order",
      opId: `${pactId}:authorize`,
      call: (requestId) => paypal.authorizeOrder({ requestId, orderId }),
      resourceIdOf: (o) => o.purchase_units[0]?.payments?.authorizations?.[0]?.id ?? o.id,
    });
    if (op.status === "unknown") {
      appendEvent(db, pactId, "hold.unknown", { error: op.error.message });
      return { ok: false, code: "unknown", message: "authorize outcome unknown; retry", pact: getPact(db, pactId) };
    }
    if (op.status === "failed") {
      const issue = JSON.stringify(op.error.body ?? "");
      appendEvent(db, pactId, "hold.failed", { status: op.error.status, body: op.error.body });
      if (/ORDER_NOT_APPROVED/.test(issue)) return { ok: false, code: "not_approved", message: "order not approved yet", pact };
      settleReservation(db, { mandateId: pact.mandate_id, pactId, capturedCents: 0 });
      return { ok: false, code: "failed", message: `authorize failed (${op.error.status})`, pact: transition(db, pactId, "HOLD_FAILED", {}, { httpStatus: op.error.status }) };
    }
    auth = op.result.purchase_units[0]?.payments?.authorizations?.[0];
  }
  if (!auth) {
    appendEvent(db, pactId, "hold.no_authorization", { orderId, orderStatus: order.status });
    settleReservation(db, { mandateId: pact.mandate_id, pactId, capturedCents: 0 });
    return { ok: false, code: "failed", message: "no authorization returned", pact: transition(db, pactId, "HOLD_FAILED", {}, { orderId }) };
  }
  const row = recordAuthorization(db, pactId, orderId, auth);
  if (row.status !== "CREATED") {
    appendEvent(db, pactId, "hold.not_created", { authorizationId: row.id, status: row.status });
    if (row.status === "DENIED" || row.status === "VOIDED" || row.status === "EXPIRED") settleReservation(db, { mandateId: pact.mandate_id, pactId, capturedCents: 0 });
    return { ok: false, code: "failed", message: `authorization status ${row.status}`, pact: transition(db, pactId, "HOLD_FAILED", {}, { authorizationId: row.id, status: row.status }) };
  }
  const held = transition(db, pactId, "HELD", { authorized_cents: row.amount_cents }, { orderId, authorizationId: row.id, amountCents: row.amount_cents, expiresAt: row.expires_at, via: "checkout" });
  return { ok: true, pact: held };
}

export interface SweepResult {
  /** Pacts moved to CHECKOUT_EXPIRED (reservation released). */
  expired: string[];
  /** Pacts promoted to HELD from a recorded/reconciled authorization; the caller must schedule their work. */
  held: string[];
}

type Lock = <T>(pactId: string, fn: () => Promise<T>) => Promise<T>;
const noLock: Lock = (_id, fn) => fn();

/**
 * Checkout sweeper. Safe to call on a schedule. Each pact is handled under the
 * caller's per-pact lock so it cannot interleave with the approve route.
 *  1. AGREED pacts that already have a CREATED authorization (webhook, or a crash
 *     between recording and transitioning) are promoted to HELD regardless of deadline.
 *  2. Past the deadline: an in-flight or unknown authorize op keeps the reservation
 *     (reconcile from the order first); otherwise CHECKOUT_EXPIRED + release.
 */
export async function expireCheckouts(deps: FlowDeps, opts: { at?: string; lock?: Lock } = {}): Promise<SweepResult> {
  const { db, paypal } = deps;
  const at = opts.at ?? now();
  const lock = opts.lock ?? noLock;
  const result: SweepResult = { expired: [], held: [] };
  const rows = db
    .query<{ id: string; order_id: string; mandate_id: string; checkout_deadline: string | null }, []>("SELECT id, order_id, mandate_id, checkout_deadline FROM pacts WHERE status = 'AGREED' AND order_id IS NOT NULL")
    .all();
  for (const r of rows) {
    await lock(r.id, async () => {
      const cur = getPact(db, r.id);
      if (!cur || cur.status !== "AGREED") return;
      const promote = (auth: { id: string; amount_cents: number; expires_at: string | null }, via: string) => {
        transition(db, r.id, "HELD", { authorized_cents: auth.amount_cents }, { orderId: r.order_id, authorizationId: auth.id, amountCents: auth.amount_cents, expiresAt: auth.expires_at, via });
        result.held.push(r.id);
      };
      const recorded = authorizationForPact(db, r.id);
      if (recorded) {
        if (recorded.status === "CREATED") return promote(recorded, "reconcile");
        if (recorded.status === "PENDING") return; // not usable yet, not dead either
        // DENIED / VOIDED / EXPIRED: fall through to the deadline check below
      }
      const past = Boolean(r.checkout_deadline && r.checkout_deadline < at);
      if (!past) return;
      const authOp = getOp(db, `${r.id}:authorize`);
      if (authOp?.status === "pending") return; // approve route is mid-call; keep the reservation
      if (authOp && authOp.status !== "failed") {
        // succeeded-but-not-transitioned or unknown: the order is the source of truth
        const order = await paypal.getOrder(r.order_id).catch(() => null);
        const auth = order?.purchase_units[0]?.payments?.authorizations?.[0];
        if (auth) {
          const row = recordAuthorization(db, r.id, r.order_id, auth);
          if (row.status === "CREATED") return promote(row, "reconcile");
        }
        if (authOp.status === "unknown" && !order) return; // still unknown; keep the reservation
      }
      const tx = db.transaction(() => {
        const again = getPact(db, r.id);
        if (!again || again.status !== "AGREED") return false;
        transition(db, r.id, "CHECKOUT_EXPIRED", {}, { orderId: r.order_id });
        settleReservation(db, { mandateId: r.mandate_id, pactId: r.id, capturedCents: 0 });
        return true;
      });
      if (tx()) result.expired.push(r.id);
    });
  }
  return result;
}
