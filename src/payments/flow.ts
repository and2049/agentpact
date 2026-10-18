/**
 * Payment flow for one pact: hold -> settle -> payout. Each step is driven by
 * the job state machine and the ops log; job transitions key off PROVIDER
 * status (resource rows), never off the HTTP outcome alone.
 */
import type { Db } from "../db";
import { appendEvent } from "../db";
import { settleReservation, reserve, MandateViolation } from "../mandate";
import { getPact, jobOf, transition } from "../pact/machine";
import type { ItemVerdict } from "../pact/types";
import type { CardSource, PayPalApi } from "../paypal/client";
import { computeSettlement } from "../settlement";
import { runOp } from "./ops";
import { authorizationForPact, captureForPact, payoutForPact, recordAuthorization, recordCapture, recordPayoutItems } from "./resources";

export interface FlowDeps {
  db: Db;
  paypal: PayPalApi;
  buyerCard: CardSource;
  sellerEmail: string;
}

/** AGREED -> HELD (or HOLD_FAILED). Reserves the mandate first, atomically. */
export async function holdPact(deps: FlowDeps, pactId: string): Promise<ReturnType<typeof getPact>> {
  const { db, paypal } = deps;
  const pact = getPact(db, pactId);
  if (!pact) throw new Error("pact not found");
  if (pact.status !== "AGREED") throw new Error(`cannot hold from ${pact.status}`);
  if (!pact.unit_price_cents) throw new Error("pact has no unit price");
  const job = jobOf(pact);
  const amountCents = pact.unit_price_cents * pact.item_count;

  if (pact.reserved_cents === 0) {
    try {
      reserve(db, { mandateId: pact.mandate_id, pactId, amountCents, category: job.category, seller: job.seller });
      appendEvent(db, pactId, "mandate.reserved", { amountCents });
    } catch (e) {
      if (e instanceof MandateViolation) {
        appendEvent(db, pactId, "mandate.violation", { code: e.code, message: e.message });
        return transition(db, pactId, "HOLD_FAILED", {}, { reason: e.message });
      }
      throw e;
    }
  }

  const op = await runOp({
    db,
    pactId,
    kind: "create_order_authorize",
    opId: `${pactId}:hold`,
    call: (requestId) =>
      paypal.createCardAuthorizedOrder({ requestId, amountCents, customId: pactId, referenceId: pactId.slice(0, 8), card: deps.buyerCard }),
    resourceIdOf: (o) => o.id,
  });

  if (op.status === "unknown") {
    appendEvent(db, pactId, "hold.unknown", { error: op.error.message });
    return getPact(db, pactId); // stays AGREED with reservation held; retry replays the same request id
  }
  if (op.status === "failed") {
    appendEvent(db, pactId, "hold.failed", { status: op.error.status, body: op.error.body });
    settleReservation(db, { mandateId: pact.mandate_id, pactId, capturedCents: 0 });
    return transition(db, pactId, "HOLD_FAILED", {}, { httpStatus: op.error.status });
  }

  const order = op.result;
  const auth = order.purchase_units[0]?.payments?.authorizations?.[0];
  if (!auth) {
    appendEvent(db, pactId, "hold.no_authorization", { orderId: order.id, orderStatus: order.status });
    settleReservation(db, { mandateId: pact.mandate_id, pactId, capturedCents: 0 });
    return transition(db, pactId, "HOLD_FAILED", {}, { orderId: order.id, orderStatus: order.status });
  }
  const row = recordAuthorization(db, pactId, order.id, auth);
  if (row.status !== "CREATED") {
    // DENIED / PENDING / etc. Only CREATED is a usable hold.
    appendEvent(db, pactId, "hold.not_created", { authorizationId: row.id, status: row.status });
    if (row.status === "DENIED") settleReservation(db, { mandateId: pact.mandate_id, pactId, capturedCents: 0 });
    return transition(db, pactId, "HOLD_FAILED", {}, { authorizationId: row.id, status: row.status });
  }
  return transition(db, pactId, "HELD", { authorized_cents: amountCents }, { orderId: order.id, authorizationId: auth.id, amountCents, expiresAt: row.expires_at });
}

/**
 * VERIFIED -> SETTLING -> SETTLED | SETTLEMENT_FAILED.
 * One settlement decision per pact: the decision is persisted on the SETTLING
 * transition and reused on retry.
 */
export async function settlePact(deps: FlowDeps, pactId: string, verdicts: ItemVerdict[]): Promise<ReturnType<typeof getPact>> {
  const { db, paypal } = deps;
  let pact = getPact(db, pactId);
  if (!pact) throw new Error("pact not found");
  if (!pact.unit_price_cents) throw new Error("pact has no unit price");
  const auth = authorizationForPact(db, pactId);
  if (!auth) throw new Error("no authorization for pact");

  if (pact.status === "VERIFIED") {
    const s = computeSettlement({ verdicts, itemCount: pact.item_count, unitPriceCents: pact.unit_price_cents });
    pact = transition(db, pactId, "SETTLING", { settlement_kind: s.kind, accepted_count: s.acceptedCount, charge_cents: s.chargeCents }, s);
  } else if (pact.status !== "SETTLING" && pact.status !== "SETTLEMENT_FAILED") {
    throw new Error(`cannot settle from ${pact.status}`);
  }
  if (pact.status === "SETTLEMENT_FAILED") pact = transition(db, pactId, "SETTLING", {}, { retry: true });

  const kind = pact.settlement_kind!;
  const chargeCents = pact.charge_cents!;

  if (kind === "void") {
    const op = await runOp({
      db,
      pactId,
      kind: "void",
      opId: `${pactId}:void`,
      call: (requestId) => paypal.voidAuthorization({ requestId, authorizationId: auth.id }),
      resourceIdOf: (a) => a.id,
    });
    if (op.status === "unknown") {
      // Reconcile by reading the authorization.
      const fresh = await paypal.getAuthorization(auth.id).catch(() => null);
      if (fresh) recordAuthorization(db, pactId, auth.order_id, fresh);
      if (fresh?.status !== "VOIDED") {
        appendEvent(db, pactId, "settle.unknown", { error: op.error.message });
        return getPact(db, pactId);
      }
    } else if (op.status === "failed") {
      appendEvent(db, pactId, "settle.failed", { status: op.error.status, body: op.error.body });
      return transition(db, pactId, "SETTLEMENT_FAILED", {}, { httpStatus: op.error.status });
    } else {
      recordAuthorization(db, pactId, auth.order_id, op.result);
    }
    const a = authorizationForPact(db, pactId)!;
    if (a.status !== "VOIDED") {
      appendEvent(db, pactId, "settle.void_not_confirmed", { status: a.status });
      return transition(db, pactId, "SETTLEMENT_FAILED", {}, { authorizationStatus: a.status });
    }
    settleReservation(db, { mandateId: pact.mandate_id, pactId, capturedCents: 0 });
    return transition(db, pactId, "SETTLED", {}, { kind, chargeCents: 0, releasedCents: auth.amount_cents });
  }

  // full or partial: a single final capture.
  const op = await runOp({
    db,
    pactId,
    kind: "capture",
    opId: `${pactId}:capture`,
    call: (requestId) => paypal.captureAuthorization({ requestId, authorizationId: auth.id, amountCents: chargeCents, final: true }),
    resourceIdOf: (c) => c.id,
  });
  if (op.status === "unknown") {
    appendEvent(db, pactId, "settle.unknown", { error: op.error.message });
    return getPact(db, pactId); // stays SETTLING; retry replays the request id
  }
  if (op.status === "failed") {
    appendEvent(db, pactId, "settle.failed", { status: op.error.status, body: op.error.body });
    return transition(db, pactId, "SETTLEMENT_FAILED", {}, { httpStatus: op.error.status });
  }
  recordCapture(db, pactId, auth.id, op.result);
  return confirmCapture(deps, pactId);
}

/**
 * Promote SETTLING -> SETTLED only when the capture's provider status is
 * COMPLETED. PENDING keeps SETTLING (poll again). DECLINED/FAILED -> SETTLEMENT_FAILED.
 */
export async function confirmCapture(deps: FlowDeps, pactId: string): Promise<ReturnType<typeof getPact>> {
  const { db, paypal } = deps;
  const pact = getPact(db, pactId);
  if (!pact || pact.status !== "SETTLING") return pact;
  let cap = captureForPact(db, pactId);
  if (!cap) return pact;
  if (cap.status === "PENDING") {
    const fresh = await paypal.getCapture(cap.id).catch(() => null);
    if (fresh) cap = recordCapture(db, pactId, cap.authorization_id, fresh);
  }
  if (cap.status === "COMPLETED") {
    let auth = authorizationForPact(db, pactId)!;
    // Refresh the authorization row so its provider status reflects the capture (CAPTURED / PARTIALLY_CAPTURED).
    const freshAuth = await paypal.getAuthorization(auth.id).catch(() => null);
    if (freshAuth) auth = recordAuthorization(db, pactId, auth.order_id, freshAuth);
    settleReservation(db, { mandateId: pact.mandate_id, pactId, capturedCents: cap.amount_cents });
    return transition(db, pactId, "SETTLED", {}, { kind: pact.settlement_kind, chargeCents: cap.amount_cents, releasedCents: auth.amount_cents - cap.amount_cents, captureId: cap.id });
  }
  if (cap.status === "DECLINED" || cap.status === "FAILED") {
    appendEvent(db, pactId, "settle.capture_failed", { captureId: cap.id, status: cap.status });
    return transition(db, pactId, "SETTLEMENT_FAILED", {}, { captureId: cap.id, status: cap.status });
  }
  appendEvent(db, pactId, "settle.capture_pending", { captureId: cap.id, status: cap.status });
  return pact;
}

/** SETTLED (with a COMPLETED capture) -> PAID_OUT once the payout ITEM is SUCCESS. */
export async function payoutPact(deps: FlowDeps, pactId: string): Promise<ReturnType<typeof getPact>> {
  const { db, paypal } = deps;
  const pact = getPact(db, pactId);
  if (!pact) throw new Error("pact not found");
  if (pact.status !== "SETTLED") throw new Error(`cannot pay out from ${pact.status}`);
  if (pact.settlement_kind === "void") throw new Error("nothing to pay out on a void");
  const cap = captureForPact(db, pactId);
  if (!cap || cap.status !== "COMPLETED") throw new Error("payout requires a COMPLETED capture");

  let item = payoutForPact(db, pactId);
  if (!item) {
    const op = await runOp({
      db,
      pactId,
      kind: "payout",
      opId: `${pactId}:payout`,
      call: (requestId) =>
        paypal.createPayout({
          requestId,
          senderBatchId: `${pactId}:payout`,
          senderItemId: `${pactId}:1`,
          receiverEmail: deps.sellerEmail,
          amountCents: cap.amount_cents,
          note: `AgentPact ${pactId.slice(0, 8)}: ${pact.accepted_count} accepted items`,
        }),
      resourceIdOf: (b) => b.batch_header.payout_batch_id,
    });
    if (op.status !== "succeeded") {
      appendEvent(db, pactId, "payout.not_sent", { status: op.status, error: op.error.message });
      return pact;
    }
    const batch = op.result.items?.length ? op.result : await paypal.getPayout(op.result.batch_header.payout_batch_id);
    const rows = recordPayoutItems(db, pactId, batch);
    item = rows[0] ?? null;
    appendEvent(db, pactId, "payout.sent", { batchId: batch.batch_header.payout_batch_id, itemStatus: item?.status });
  }
  return confirmPayout(deps, pactId);
}

export async function confirmPayout(deps: FlowDeps, pactId: string): Promise<ReturnType<typeof getPact>> {
  const { db, paypal } = deps;
  const pact = getPact(db, pactId);
  if (!pact || pact.status !== "SETTLED") return pact;
  let item = payoutForPact(db, pactId);
  if (!item) return pact;
  if (item.status === "PENDING" || item.status === "ONHOLD") {
    const batch = await paypal.getPayout(item.batch_id).catch(() => null);
    if (batch) item = recordPayoutItems(db, pactId, batch)[0] ?? item;
  }
  if (item.status === "SUCCESS") {
    return transition(db, pactId, "PAID_OUT", {}, { payoutItemId: item.item_id, amountCents: item.amount_cents, receiver: item.receiver });
  }
  appendEvent(db, pactId, "payout.pending", { itemId: item.item_id, status: item.status });
  return pact;
}
