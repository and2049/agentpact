/**
 * Durable stages of one pact. Each function moves the pact across exactly one
 * boundary and is safe to call again after a crash (it reads its inputs from
 * the database, never from memory). `advance` dispatches on the current status
 * and tells the worker when to come back.
 *
 *   demo   DRAFT -> OFFERED -> AGREED -> HELD (card)   negotiate + hold
 *   market AGREED (order_id) ... HELD                   via payments/checkout
 *   HELD -> DELIVERED -> VERIFIED -> SETTLING -> SETTLED -> PAID_OUT
 */
import type { Decision } from "../agents/buyer";
import type { Quote } from "../agents/seller";
import type { Db } from "../db";
import { appendEvent, now } from "../db";
import { injectFault } from "../faults";
import { getMandate, type Mandate } from "../mandate";
import { confirmCapture, confirmPayout, holdPact, payoutPact, settlePact, type FlowDeps } from "../payments/flow";
import type { Rubric } from "../verifier";
import { verify } from "../verifier";
import { getPact, jobOf, pactHash, transition } from "./machine";
import type { Artifact, ItemVerdict, JobSpec, Offer, PactRow } from "./types";

export interface Agents {
  quote: (job: JobSpec) => Promise<Quote>;
  decide: (job: JobSpec, quote: Quote, mandate: Mandate) => Promise<Decision>;
  produce: (job: JobSpec, onBatch?: (items: Artifact) => void) => Promise<Artifact>;
  rubric: Rubric;
}

export interface StageDeps {
  flow: FlowDeps;
  /** Agents for a given pact: demo pacts use the platform's models, market pacts the seller agent's. */
  agentsFor: (pact: PactRow) => Agents;
  /** Poll interval for pending captures/payouts (ms). */
  pollMs?: number;
}

export const say = (db: Db, pactId: string, role: "buyer" | "seller" | "verifier" | "platform", text: string, extra: Record<string, unknown> = {}) =>
  appendEvent(db, pactId, "agent.message", { role, text, ...extra });

export const TERMINAL: PactRow["status"][] = ["PAID_OUT", "REJECTED", "HOLD_FAILED", "CHECKOUT_EXPIRED", "SETTLEMENT_FAILED"];

/** Demo only: seller quotes, buyer agent decides, server enforces. DRAFT -> OFFERED -> AGREED | REJECTED. */
export async function negotiate(deps: StageDeps, pactId: string): Promise<PactRow> {
  const db = deps.flow.db;
  let pact = getPact(db, pactId)!;
  const job = jobOf(pact);
  const mandate = getMandate(db, pact.mandate_id);
  if (!mandate) throw new Error("mandate not found");
  const agents = deps.agentsFor(pact);

  let offer: Offer;
  let quoteMessage: string;
  if (pact.status === "DRAFT") {
    const quote = await agents.quote(job);
    offer = { unitPriceCents: quote.unitPriceCents, etaMinutes: quote.etaMinutes, note: quote.message };
    quoteMessage = quote.message;
    say(db, pactId, "seller", quote.message, { quote: offer });
    pact = transition(db, pactId, "OFFERED", { offer_json: JSON.stringify(offer), unit_price_cents: offer.unitPriceCents }, offer);
  } else {
    offer = JSON.parse(pact.offer_json!) as Offer;
    quoteMessage = offer.note;
  }

  const decision = await agents.decide(job, { unitPriceCents: offer.unitPriceCents, etaMinutes: offer.etaMinutes, message: quoteMessage }, mandate);
  const total = offer.unitPriceCents * job.skus.length;
  const hardReject =
    offer.unitPriceCents > job.maxUnitPriceCents
      ? `unit price ${offer.unitPriceCents}¢ exceeds the job maximum ${job.maxUnitPriceCents}¢`
      : total > mandate.max_per_pact_cents
        ? `total ${total}¢ exceeds the mandate's per-pact limit ${mandate.max_per_pact_cents}¢`
        : null;
  if (hardReject || !decision.accept) {
    say(db, pactId, "buyer", hardReject ? `Rejecting: ${hardReject}.` : decision.message, { enforced: Boolean(hardReject) });
    return transition(db, pactId, "REJECTED", {}, { reason: hardReject ?? decision.message, enforced: Boolean(hardReject) });
  }
  say(db, pactId, "buyer", decision.message);
  const hash = await pactHash(job, offer);
  return transition(db, pactId, "AGREED", { pact_hash: hash }, { unitPriceCents: offer.unitPriceCents, totalCents: total, hash });
}

/** Demo only: card hold. AGREED -> HELD | HOLD_FAILED (or unchanged when the outcome is unknown). */
export async function holdStage(deps: StageDeps, pactId: string): Promise<PactRow> {
  const db = deps.flow.db;
  const pact = getPact(db, pactId)!;
  const total = (pact.unit_price_cents ?? 0) * pact.item_count;
  say(db, pactId, "platform", `Authorizing ${total}¢ on the buyer's PayPal. Nothing is captured until verification.`);
  const held = await holdPact(deps.flow, pactId);
  if (held?.status !== "HELD") say(db, pactId, "platform", `Hold ${held?.status === "AGREED" ? "outcome unknown; retrying" : `failed (${held?.status}). Stopping`}.`);
  return held!;
}

/** HELD -> DELIVERED. The seller agent produces the artifact; demo scenarios inject a disclosed fault. */
export async function workStage(deps: StageDeps, pactId: string): Promise<PactRow> {
  const db = deps.flow.db;
  const pact = getPact(db, pactId)!;
  const job = jobOf(pact);
  say(db, pactId, "seller", "Starting the work.");
  const artifact = await deps.agentsFor(pact).produce(job, (b) => appendEvent(db, pactId, "seller.progress", { skus: b.map((i) => i.sku) }));
  const scenario = pact.kind === "demo" ? (pact.scenario ?? "good") : "good";
  const { raw, report } = injectFault(job, artifact, scenario);
  if (scenario !== "good") appendEvent(db, pactId, "fault.injected", report);
  db.run("INSERT OR REPLACE INTO artifacts (pact_id, body_json, submitted_at) VALUES (?, ?, ?)", [pactId, JSON.stringify(raw), now()]);
  const delivered = Array.isArray(raw) ? raw.length : 0;
  say(db, pactId, "seller", `Delivering ${delivered || "the"} item${delivered === 1 ? "" : "s"}.`);
  return transition(db, pactId, "DELIVERED", {}, { itemsDelivered: delivered, fault: report.note });
}

/** DELIVERED -> VERIFIED. Verdicts are persisted per item as they arrive. */
export async function verifyStage(deps: StageDeps, pactId: string): Promise<PactRow> {
  const db = deps.flow.db;
  const pact = getPact(db, pactId)!;
  const job = jobOf(pact);
  const art = db.query<{ body_json: string }, [string]>("SELECT body_json FROM artifacts WHERE pact_id = ?").get(pactId);
  const raw: unknown = art ? JSON.parse(art.body_json) : null;
  say(db, pactId, "verifier", "Checking schema, coverage and supplied facts, then scoring each item.");
  db.run("DELETE FROM item_verdicts WHERE pact_id = ?", [pactId]);
  const verdicts = await verify(job, raw, {
    rubric: deps.agentsFor(pact).rubric,
    concurrency: 4,
    onItem: (v) => {
      db.run("INSERT OR REPLACE INTO item_verdicts (pact_id, sku, verdict, reason, score, evidence_json) VALUES (?, ?, ?, ?, ?, ?)", [pactId, v.sku, v.verdict, v.reason, v.score, JSON.stringify(v.evidence)]);
      appendEvent(db, pactId, "verifier.item", v);
    },
  });
  const accepted = verdicts.filter((v) => v.verdict === "accepted").length;
  say(db, pactId, "verifier", `${accepted} of ${job.skus.length} items accepted.`);
  return transition(db, pactId, "VERIFIED", { accepted_count: accepted }, { accepted, rejected: job.skus.length - accepted });
}

export function verdictsOf(db: Db, pactId: string): ItemVerdict[] {
  return db
    .query<{ sku: string; verdict: "accepted" | "rejected"; reason: string; score: number | null; evidence_json: string }, [string]>("SELECT * FROM item_verdicts WHERE pact_id = ?")
    .all(pactId)
    .map((r) => ({ sku: r.sku, verdict: r.verdict, reason: r.reason, score: r.score, evidence: JSON.parse(r.evidence_json) }));
}

/** VERIFIED | SETTLING -> SETTLED (capture COMPLETED or void) | SETTLEMENT_FAILED; SETTLING when the capture is pending. */
export async function settleStage(deps: StageDeps, pactId: string): Promise<PactRow> {
  const db = deps.flow.db;
  const before = getPact(db, pactId)!;
  const p = before.status === "VERIFIED" ? await settlePact(deps.flow, pactId, verdictsOf(db, pactId)) : await confirmCapture(deps.flow, pactId);
  if (p?.status === "SETTLED") {
    const text = p.settlement_kind === "void" ? "Voided the authorization; the buyer pays nothing." : p.settlement_kind === "full" ? `Captured ${p.charge_cents}¢ in full.` : `Captured ${p.charge_cents}¢ for ${p.accepted_count} accepted items; the remaining authorization is released.`;
    say(db, pactId, "platform", text);
  } else if (p?.status === "SETTLEMENT_FAILED") {
    say(db, pactId, "platform", "Settlement failed; an operator must reconcile before retrying.");
  }
  return p!;
}

/** SETTLED (capture COMPLETED) -> PAID_OUT once the payout item is SUCCESS. */
export async function payoutStage(deps: StageDeps, pactId: string): Promise<PactRow> {
  const db = deps.flow.db;
  const p = await payoutPact(deps.flow, pactId);
  if (p?.status === "PAID_OUT") say(db, pactId, "platform", `Paid the seller ${p.charge_cents}¢.`);
  return p!;
}

export type Next = { again: number } | { done: true } | { wait: true };

/**
 * Run the next stage for a pact. Returns when the worker should come back:
 * `again` in N ms (0 = immediately), `wait` for an external event (buyer approval), or `done`.
 */
export async function advance(deps: StageDeps, pactId: string): Promise<Next> {
  const db = deps.flow.db;
  const pact = getPact(db, pactId);
  if (!pact) return { done: true };
  const poll = deps.pollMs ?? 3000;
  const finish = (p: PactRow): Next => {
    appendEvent(db, pactId, "run.finished", { status: p.status, kind: p.settlement_kind, chargeCents: p.charge_cents });
    return { done: true };
  };
  switch (pact.status) {
    case "DRAFT":
    case "OFFERED": {
      if (pact.kind !== "demo") return { wait: true };
      const p = await negotiate(deps, pactId);
      return p.status === "REJECTED" ? { done: true } : { again: 0 };
    }
    case "AGREED": {
      if (pact.kind !== "demo") return { wait: true }; // market: buyer approval + completeCheckout move it to HELD
      const p = await holdStage(deps, pactId);
      if (p.status === "HELD") return { again: 0 };
      if (p.status === "AGREED") return { again: poll }; // unknown outcome; retry replays the request id
      return finish(p);
    }
    case "HELD":
      await workStage(deps, pactId);
      return { again: 0 };
    case "DELIVERED":
      await verifyStage(deps, pactId);
      return { again: 0 };
    case "VERIFIED":
    case "SETTLING": {
      const p = await settleStage(deps, pactId);
      if (p.status === "SETTLING") return { again: poll };
      if (p.status === "SETTLED") return p.settlement_kind === "void" ? finish(p) : { again: 0 };
      return finish(p);
    }
    case "SETTLED": {
      if (pact.settlement_kind === "void") return finish(pact);
      const p = await payoutStage(deps, pactId);
      if (p.status === "PAID_OUT") return finish(p);
      return { again: Math.max(poll, 5000) }; // payout.pending events carry the status; no chatter

    }
    default:
      return { done: true };
  }
}

/** Last-resort: a terminal payout confirmation for pacts whose payout item stayed pending. */
export async function pollPayout(deps: StageDeps, pactId: string): Promise<PactRow | null> {
  return confirmPayout(deps.flow, pactId);
}
