/**
 * Orchestrates one pact end to end:
 *   job -> seller quote -> buyer decision (server-enforced) -> hold
 *   -> seller work (+ disclosed fault injection) -> delivery -> verification
 *   -> settlement -> payout.
 * Every step appends events; the UI replays them over SSE.
 */
import type { Db } from "../db";
import { appendEvent, now } from "../db";
import type { Decision } from "../agents/buyer";
import type { Quote } from "../agents/seller";
import { injectFault, type Scenario } from "../faults";
import { getMandate, type Mandate } from "../mandate";
import { confirmCapture, confirmPayout, holdPact, payoutPact, settlePact, type FlowDeps } from "../payments/flow";
import type { Rubric } from "../verifier";
import { verify } from "../verifier";
import { createPact, getPact, pactHash, transition } from "./machine";
import type { Artifact, ItemVerdict, JobSpec, Offer, PactRow } from "./types";

export interface Agents {
  quote: (job: JobSpec) => Promise<Quote>;
  decide: (job: JobSpec, quote: Quote, mandate: Mandate) => Promise<Decision>;
  produce: (job: JobSpec, onBatch?: (items: Artifact) => void) => Promise<Artifact>;
  rubric: Rubric;
}

export interface RunDeps {
  flow: FlowDeps;
  agents: Agents;
  /** Poll interval for pending captures/payouts (ms). Tests set it small. */
  pollMs?: number;
  maxPolls?: number;
}

export interface RunArgs {
  mandateId: string;
  job: JobSpec;
  scenario: Scenario;
}

const say = (db: Db, pactId: string, role: "buyer" | "seller" | "verifier" | "platform", text: string, extra: Record<string, unknown> = {}) =>
  appendEvent(db, pactId, "agent.message", { role, text, ...extra });

export async function runPact(deps: RunDeps, args: RunArgs): Promise<PactRow> {
  const db = deps.flow.db;
  const { job, scenario } = args;
  const mandate = getMandate(db, args.mandateId);
  if (!mandate) throw new Error("mandate not found");

  const pact = createPact(db, mandate.id, job);
  const id = pact.id;
  appendEvent(db, id, "run.started", { scenario, jobId: job.id, itemCount: job.skus.length, maxUnitPriceCents: job.maxUnitPriceCents });
  say(db, id, "buyer", `Posting job "${job.title}": ${job.skus.length} items, max ${job.maxUnitPriceCents}¢ each. Payment is per accepted item after verification.`);

  // 1. Quote
  const quote = await deps.agents.quote(job);
  const offer: Offer = { unitPriceCents: quote.unitPriceCents, etaMinutes: quote.etaMinutes, note: quote.message };
  say(db, id, "seller", quote.message, { quote: offer });
  transition(db, id, "OFFERED", { offer_json: JSON.stringify(offer), unit_price_cents: offer.unitPriceCents }, offer);

  // 2. Decision: the agent reasons, the server enforces.
  const decision = await deps.agents.decide(job, quote, mandate);
  const total = offer.unitPriceCents * job.skus.length;
  const hardReject =
    offer.unitPriceCents > job.maxUnitPriceCents
      ? `unit price ${offer.unitPriceCents}¢ exceeds the job maximum ${job.maxUnitPriceCents}¢`
      : total > mandate.max_per_pact_cents
        ? `total ${total}¢ exceeds the mandate's per-pact limit ${mandate.max_per_pact_cents}¢`
        : null;
  if (hardReject || !decision.accept) {
    say(db, id, "buyer", hardReject ? `Rejecting: ${hardReject}.` : decision.message, { enforced: Boolean(hardReject) });
    return transition(db, id, "REJECTED", {}, { reason: hardReject ?? decision.message, enforced: Boolean(hardReject) });
  }
  say(db, id, "buyer", decision.message);
  const hash = await pactHash(job, offer);
  transition(db, id, "AGREED", { pact_hash: hash }, { unitPriceCents: offer.unitPriceCents, totalCents: total, hash });

  // 3. Hold
  say(db, id, "platform", `Authorizing ${total}¢ on the buyer's PayPal. Nothing is captured until verification.`);
  const held = await holdPact(deps.flow, id);
  if (held?.status !== "HELD") {
    say(db, id, "platform", `Hold failed (${held?.status}). Stopping.`);
    return held!;
  }

  // 4. Work + delivery
  say(db, id, "seller", "Starting the work.");
  const artifact = await deps.agents.produce(job, (b) => appendEvent(db, id, "seller.progress", { skus: b.map((i) => i.sku) }));
  const { raw, report } = injectFault(job, artifact, scenario);
  if (scenario !== "good") appendEvent(db, id, "fault.injected", report);
  db.run("INSERT OR REPLACE INTO artifacts (pact_id, body_json, submitted_at) VALUES (?, ?, ?)", [id, JSON.stringify(raw), now()]);
  const delivered = Array.isArray(raw) ? raw.length : 0;
  say(db, id, "seller", `Delivering ${delivered || "the"} item${delivered === 1 ? "" : "s"}.`);
  transition(db, id, "DELIVERED", {}, { itemsDelivered: delivered, fault: report.note });

  // 5. Verification
  say(db, id, "verifier", "Checking schema, coverage and supplied facts, then scoring each item.");
  const verdicts: ItemVerdict[] = await verify(job, raw, {
    rubric: deps.agents.rubric,
    concurrency: 4,
    onItem: (v) => {
      db.run("INSERT OR REPLACE INTO item_verdicts (pact_id, sku, verdict, reason, score, evidence_json) VALUES (?, ?, ?, ?, ?, ?)", [id, v.sku, v.verdict, v.reason, v.score, JSON.stringify(v.evidence)]);
      appendEvent(db, id, "verifier.item", v);
    },
  });
  const accepted = verdicts.filter((v) => v.verdict === "accepted").length;
  say(db, id, "verifier", `${accepted} of ${job.skus.length} items accepted.`);
  transition(db, id, "VERIFIED", { accepted_count: accepted }, { accepted, rejected: job.skus.length - accepted });

  // 6. Settlement
  let p = await settlePact(deps.flow, id, verdicts);
  for (let i = 0; i < (deps.maxPolls ?? 20) && p?.status === "SETTLING"; i++) {
    await Bun.sleep(deps.pollMs ?? 3000);
    p = await confirmCapture(deps.flow, id);
  }
  if (p?.status !== "SETTLED") {
    say(db, id, "platform", `Settlement did not complete (${p?.status}).`);
    return p!;
  }
  const kindText = p.settlement_kind === "void" ? "Voided the authorization; the buyer pays nothing." : p.settlement_kind === "full" ? `Captured ${p.charge_cents}¢ in full.` : `Captured ${p.charge_cents}¢ for ${p.accepted_count} accepted items; the remaining authorization is released.`;
  say(db, id, "platform", kindText);

  // 7. Payout
  if (p.settlement_kind !== "void") {
    p = await payoutPact(deps.flow, id);
    for (let i = 0; i < (deps.maxPolls ?? 20) && p?.status === "SETTLED"; i++) {
      await Bun.sleep(deps.pollMs ?? 5000);
      p = await confirmPayout(deps.flow, id);
    }
    say(db, id, "platform", p?.status === "PAID_OUT" ? `Paid the seller ${p.charge_cents}¢.` : `Payout pending (${p?.status}).`);
  }
  appendEvent(db, id, "run.finished", { status: p?.status, kind: p?.settlement_kind, chargeCents: p?.charge_cents });
  return getPact(db, id)!;
}
