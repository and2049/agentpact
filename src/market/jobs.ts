/**
 * Jobs, quotes and award. Award freezes the agreement into the pact and hands
 * off to payments/checkout (approval order); nothing here touches settlement.
 */
import { z } from "zod";
import { appendEvent, now, type Db } from "../db";
import { ANY, createMandate, mandateForOwner, type Mandate } from "../mandate";
import { usd } from "../money";
import { createPact, getPact, pactHash, transition } from "../pact/machine";
import { say } from "../pact/stages";
import { JobSpec, SkuFacts, type Offer, type PactRow } from "../pact/types";
import { beginCheckout, type CheckoutResult } from "../payments/checkout";
import type { FlowDeps } from "../payments/flow";
import { agentUsable, getAgent, quotesTodayFor, type AgentRow } from "./agents";

export const TEMPLATES = {
  product_descriptions: {
    name: "Product descriptions",
    rubric: {
      criteria: [
        "Mentions every supplied fact without altering it",
        "Contains no invented specifications, certifications, awards or comparisons",
        "Reads as a coherent, specific product description rather than filler",
      ],
      threshold: 0.6,
      minWords: 30,
      maxWords: 90,
    },
  },
} as const;
export type TemplateId = keyof typeof TEMPLATES;

export const JobInput = z.object({
  template: z.literal("product_descriptions").default("product_descriptions"),
  title: z.string().trim().min(3).max(120),
  brief: z.string().trim().min(10).max(2000),
  items: z.array(z.object({ sku: z.string().trim().min(1).max(40), facts: SkuFacts })).min(1).max(20),
  maxUnitPriceCents: z.number().int().min(1).max(100_000),
  minWords: z.number().int().min(5).max(500).optional(),
  maxWords: z.number().int().min(5).max(1000).optional(),
  /** Direct hire: only this agent is asked to quote, and the job stays off the public board. */
  agentId: z.string().min(1).max(64).optional(),
});
export type JobInput = z.infer<typeof JobInput>;

export interface JobRow {
  id: string;
  buyer_id: string;
  template: TemplateId;
  title: string;
  brief: string;
  items_json: string;
  rubric_json: string;
  max_unit_price_cents: number;
  status: "OPEN" | "AWARDED" | "CLOSED";
  pact_id: string | null;
  /** Set for a direct hire: the one agent invited to quote. */
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteRow {
  id: string;
  job_id: string;
  agent_id: string;
  seller_id: string;
  unit_price_cents: number;
  eta_minutes: number;
  message: string;
  status: "pending" | "open" | "awarded" | "lost";
  created_at: string;
}

export class JobError extends Error {
  constructor(
    public code: "not_found" | "forbidden" | "state" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/** Abuse limits: quoting spends model budget, so posting is capped per account. */
export const JOB_LIMITS = { perDay: 10, open: 5 };

export function createJob(db: Db, buyerId: string, input: JobInput, opts: { enforceLimits?: boolean } = {}): JobRow {
  const skus = new Set(input.items.map((i) => i.sku));
  if (skus.size !== input.items.length) throw new JobError("invalid", "duplicate SKUs");
  if (opts.enforceLimits) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const today = db.query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM jobs WHERE buyer_id = ? AND created_at > ?").get(buyerId, since)!.n;
    if (today >= JOB_LIMITS.perDay) throw new JobError("invalid", `at most ${JOB_LIMITS.perDay} jobs per day`);
    const open = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM jobs WHERE buyer_id = ? AND status = 'OPEN'").get(buyerId)!.n;
    if (open >= JOB_LIMITS.open) throw new JobError("invalid", `at most ${JOB_LIMITS.open} open jobs at a time; award or cancel one first`);
  }
  const t = TEMPLATES[input.template];
  const rubric = { ...t.rubric, minWords: input.minWords ?? t.rubric.minWords, maxWords: input.maxWords ?? t.rubric.maxWords };
  if (rubric.minWords > rubric.maxWords) throw new JobError("invalid", "minWords must be <= maxWords");
  if (input.agentId) {
    // Direct hire: refuse up front what would otherwise end as a job nobody quotes.
    const a = getAgent(db, input.agentId);
    if (!agentUsable(a)) throw new JobError("invalid", "that agent is not available for hire");
    if (a.owner_id === buyerId) throw new JobError("invalid", "you cannot hire your own agent");
    if (a.min_unit_price_cents > input.maxUnitPriceCents) throw new JobError("invalid", `${a.name} starts at ${usd(a.min_unit_price_cents)} per item; raise the maximum price`);
    if (a.max_items_per_job < input.items.length) throw new JobError("invalid", `${a.name} takes at most ${a.max_items_per_job} items per job`);
    if (quotesTodayFor(db, a.id) >= a.max_quotes_per_day) throw new JobError("invalid", `${a.name} has reached its daily quote limit; try again tomorrow`);
  }
  const id = crypto.randomUUID();
  const ts = now();
  db.run(
    "INSERT INTO jobs (id, buyer_id, template, title, brief, items_json, rubric_json, max_unit_price_cents, status, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)",
    [id, buyerId, input.template, input.title, input.brief, JSON.stringify(input.items), JSON.stringify(rubric), input.maxUnitPriceCents, input.agentId ?? null, ts, ts],
  );
  return getJob(db, id)!;
}

export function getJob(db: Db, id: string): JobRow | null {
  return db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id) ?? null;
}

/** `board`: the public job board, which leaves out direct hires (private offers) and the jobs of automated demo runs. */
export function listJobs(db: Db, opts: { status?: JobRow["status"]; buyerId?: string; board?: boolean } = {}): JobRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.board) where.push("agent_id IS NULL AND NOT EXISTS (SELECT 1 FROM pacts p WHERE p.id = jobs.pact_id AND p.kind = 'demo')");
  if (opts.status) {
    where.push("status = ?");
    args.push(opts.status);
  }
  if (opts.buyerId) {
    where.push("buyer_id = ?");
    args.push(opts.buyerId);
  }
  return db.query<JobRow, string[]>(`SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 200`).all(...args);
}

export function listQuotes(db: Db, jobId: string): QuoteRow[] {
  return db.query<QuoteRow, [string]>("SELECT * FROM quotes WHERE job_id = ? ORDER BY unit_price_cents, created_at").all(jobId);
}

export function getQuote(db: Db, id: string): QuoteRow | null {
  return db.query<QuoteRow, [string]>("SELECT * FROM quotes WHERE id = ?").get(id) ?? null;
}

/** The JobSpec the pact and verifier work from. `seller` is the recipient email, frozen at award. */
export function jobSpecOf(job: JobRow, sellerEmail: string): JobSpec {
  return JobSpec.parse({
    id: job.id,
    category: job.template,
    title: job.title,
    brief: job.brief,
    skus: JSON.parse(job.items_json),
    rubric: JSON.parse(job.rubric_json),
    maxUnitPriceCents: job.max_unit_price_cents,
    seller: sellerEmail,
  });
}

/** Which active agents may quote this job, within their band, size and daily limits. */
export function eligibleAgents(db: Db, job: JobRow, limit = 5): AgentRow[] {
  const items = (JSON.parse(job.items_json) as unknown[]).length;
  const rows = db
    .query<AgentRow, [number, number]>("SELECT * FROM agents WHERE status = 'active' AND min_unit_price_cents <= ? AND max_items_per_job >= ? ORDER BY created_at")
    .all(job.max_unit_price_cents, items);
  const out: AgentRow[] = [];
  for (const a of rows) {
    if (job.agent_id && a.id !== job.agent_id) continue; // direct hire: only the invited agent
    if (!agentUsable(a)) continue; // paused, or no key bound to this provider
    if (a.owner_id === job.buyer_id) continue; // no self-dealing
    if (quotesTodayFor(db, a.id) >= a.max_quotes_per_day) continue;
    if (db.query<{ id: string }, [string, string]>("SELECT id FROM quotes WHERE job_id = ? AND agent_id = ?").get(job.id, a.id)) continue;
    out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Persist the agent selection for a job before any model is called, so a crash mid-quoting resumes
 * exactly these agents instead of selecting more. Returns the agents still to be quoted.
 */
export function reserveQuoteSlots(db: Db, job: JobRow, limit = 5): AgentRow[] {
  const pending = db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM quotes WHERE job_id = ? AND status = 'pending'").all(job.id).map((r) => r.agent_id);
  const any = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM quotes WHERE job_id = ?").get(job.id)!.n;
  if (any === 0) {
    for (const a of eligibleAgents(db, job, limit)) {
      db.run("INSERT OR IGNORE INTO quotes (id, job_id, agent_id, seller_id, unit_price_cents, eta_minutes, message, status, created_at) VALUES (?, ?, ?, ?, 0, 0, '', 'pending', ?)", [crypto.randomUUID(), job.id, a.id, a.owner_id, now()]);
      pending.push(a.id);
    }
  }
  return pending.map((id) => getAgent(db, id)).filter(agentUsable); // a slot whose agent became unusable stays pending (never awardable)
}

/** Record one quote, clamped into the agent's band and the job max. Idempotent per (job, agent); fills a pending slot if one exists. */
export function recordQuote(db: Db, job: JobRow, agent: AgentRow, q: { unitPriceCents: number; etaMinutes: number; message: string }): QuoteRow {
  const hi = Math.min(agent.max_unit_price_cents, job.max_unit_price_cents);
  const price = Math.max(agent.min_unit_price_cents, Math.min(hi, Math.round(q.unitPriceCents)));
  const eta = Math.max(1, Math.round(q.etaMinutes));
  const msg = q.message.slice(0, 400);
  const tx = db.transaction(() => {
    const existing = db.query<QuoteRow, [string, string]>("SELECT * FROM quotes WHERE job_id = ? AND agent_id = ?").get(job.id, agent.id);
    if (existing?.status === "pending") db.run("UPDATE quotes SET unit_price_cents = ?, eta_minutes = ?, message = ?, status = 'open', created_at = ? WHERE id = ?", [price, eta, msg, now(), existing.id]);
    else if (!existing) db.run("INSERT INTO quotes (id, job_id, agent_id, seller_id, unit_price_cents, eta_minutes, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)", [crypto.randomUUID(), job.id, agent.id, agent.owner_id, price, eta, msg, now()]);
    return db.query<QuoteRow, [string, string]>("SELECT * FROM quotes WHERE job_id = ? AND agent_id = ?").get(job.id, agent.id)!;
  });
  return tx();
}

/** Buyer mandate: created on first use with generous sandbox defaults and no category/seller pin. */
export function mandateForBuyer(db: Db, buyerId: string): Mandate {
  return mandateForOwner(db, buyerId) ?? createMandate(db, { maxPerPactCents: 5000, maxAggregateCents: 50_000, allowedCategory: ANY, allowedSeller: ANY, ownerId: buyerId });
}

export interface AwardResult {
  pact: PactRow;
  checkout: CheckoutResult;
}

/**
 * Award a quote: freeze the agreement into a new pact (one per job, enforced by
 * the job's status guard), then create the approval order. The pact stays
 * AGREED until the buyer approves in PayPal and the server authorizes.
 */
export async function awardJob(deps: { db: Db; flow: FlowDeps }, args: { jobId: string; quoteId: string; buyerId: string }): Promise<AwardResult> {
  const { db } = deps;
  const job = getJob(db, args.jobId);
  if (!job) throw new JobError("not_found", "job not found");
  if (job.buyer_id !== args.buyerId) throw new JobError("forbidden", "not your job");
  if (job.status === "AWARDED" && job.pact_id) {
    // Resume: the award committed but order creation did not complete (timeout / crash). Same op id, same request id.
    const existing = getPact(db, job.pact_id);
    if (existing && existing.status === "AGREED" && existing.quote_id === args.quoteId) {
      const checkout = await beginCheckout(deps.flow, existing.id);
      return { pact: checkout.pact ?? existing, checkout };
    }
  }
  if (job.status !== "OPEN") throw new JobError("state", `job is ${job.status}`);
  const quote = getQuote(db, args.quoteId);
  if (!quote || quote.job_id !== job.id) throw new JobError("invalid", "quote does not belong to this job");
  if (quote.status !== "open") throw new JobError("state", `quote is ${quote.status}`);
  if (!(quote.unit_price_cents > 0) || !(quote.eta_minutes > 0)) throw new JobError("invalid", "quote is incomplete");
  const agent = getAgent(db, quote.agent_id);
  if (!agentUsable(agent)) throw new JobError("state", "agent is paused or has no usable key for its provider");
  const seller = db.query<{ id: string; email: string; name: string }, [string]>("SELECT id, email, name FROM users WHERE id = ?").get(quote.seller_id);
  if (!seller) throw new JobError("invalid", "seller not found");

  const spec = jobSpecOf(job, seller.email);
  const offer: Offer = { unitPriceCents: quote.unit_price_cents, etaMinutes: quote.eta_minutes, note: quote.message };
  const hash = await pactHash(spec, offer);
  const mandate = mandateForBuyer(db, args.buyerId);

  const tx = db.transaction(() => {
    // Re-read the agent inside the transaction: the row read before the hash await may be stale
    // (a provider switch or key deletion could have landed meanwhile), and the snapshot must be what runs.
    const fresh = getAgent(db, quote.agent_id);
    if (!agentUsable(fresh)) throw new JobError("state", "agent is paused or has no usable key for its provider");
    const frozen = {
      quoteId: quote.id,
      offer,
      agent: { id: fresh.id, name: fresh.name, provider: fresh.provider, model: fresh.model, system_prompt: fresh.system_prompt },
      payout_recipient: seller.email,
      templateVersion: 1,
      frozenAt: now(),
    };
    const awarded = db.run("UPDATE jobs SET status = 'AWARDED', updated_at = ? WHERE id = ? AND status = 'OPEN'", [now(), job.id]).changes;
    if (awarded !== 1) throw new JobError("state", "job was already awarded");
    const pact = createPact(db, mandate.id, spec);
    db.run(
      "UPDATE pacts SET kind = 'market', job_id = ?, quote_id = ?, agent_id = ?, buyer_id = ?, seller_id = ?, payout_recipient = ?, frozen_json = ? WHERE id = ?",
      [job.id, quote.id, fresh.id, job.buyer_id, seller.id, seller.email, JSON.stringify(frozen), pact.id],
    );
    db.run("UPDATE jobs SET pact_id = ? WHERE id = ?", [pact.id, job.id]);
    db.run("UPDATE quotes SET status = CASE WHEN id = ? THEN 'awarded' ELSE 'lost' END WHERE job_id = ? AND status IN ('open', 'awarded', 'lost')", [quote.id, job.id]); // pending slots stay pending
    appendEvent(db, pact.id, "run.started", { kind: "market", jobId: job.id, itemCount: spec.skus.length, maxUnitPriceCents: spec.maxUnitPriceCents });
    say(db, pact.id, "buyer", `Awarded "${job.title}" to ${fresh.name} at ${usd(offer.unitPriceCents)} per item (${spec.skus.length} items). Payment is per accepted item after verification.`);
    say(db, pact.id, "seller", offer.note, { quote: offer });
    transition(db, pact.id, "OFFERED", { offer_json: JSON.stringify(offer), unit_price_cents: offer.unitPriceCents }, offer);
    return transition(db, pact.id, "AGREED", { pact_hash: hash }, { unitPriceCents: offer.unitPriceCents, totalCents: offer.unitPriceCents * spec.skus.length, hash, frozen: true });
  });
  const pact = tx();
  say(db, pact.id, "platform", `Waiting for the buyer to approve a ${usd(offer.unitPriceCents * spec.skus.length)} authorization in PayPal. Nothing is captured until verification.`);
  const checkout = await beginCheckout(deps.flow, pact.id);
  return { pact: checkout.pact ?? pact, checkout };
}

/**
 * Job lifecycle after its pact ends: no work happened (hold failed / checkout expired) -> reopen so the
 * buyer can try again; work settled (paid out, or voided) -> CLOSED.
 */
export function reopenJobFor(db: Db, pact: PactRow) {
  if (!pact.job_id) return;
  if (pact.status === "HOLD_FAILED" || pact.status === "CHECKOUT_EXPIRED") {
    if (pact.kind !== "market") return;
    db.run("UPDATE jobs SET status = 'OPEN', pact_id = NULL, updated_at = ? WHERE id = ? AND pact_id = ?", [now(), pact.job_id, pact.id]);
    db.run("UPDATE quotes SET status = 'open' WHERE job_id = ? AND status IN ('awarded', 'lost')", [pact.job_id]);
    return;
  }
  if (pact.status === "PAID_OUT" || (pact.status === "SETTLED" && pact.settlement_kind === "void") || pact.status === "REJECTED") {
    db.run("UPDATE jobs SET status = 'CLOSED', updated_at = ? WHERE id = ? AND pact_id = ? AND status = 'AWARDED'", [now(), pact.job_id, pact.id]);
  }
}
export const closeJobFor = reopenJobFor;

/**
 * Bring job rows in line with their pacts: an AWARDED job whose pact already ended (closed, voided,
 * rejected, expired, hold failed) is closed or reopened. Runs at startup and on every sweep so a crash
 * between a pact's last transition and the job update, or rows from before job closing existed, heal.
 */
export function reconcileJobs(db: Db): number {
  const rows = db.query<JobRow, []>("SELECT * FROM jobs WHERE status = 'AWARDED'").all();
  let changed = 0;
  for (const j of rows) {
    const pact = j.pact_id ? getPact(db, j.pact_id) : null;
    if (!pact) {
      db.run("UPDATE jobs SET status = 'OPEN', updated_at = ? WHERE id = ? AND status = 'AWARDED'", [now(), j.id]); // award never produced a pact
      changed++;
      continue;
    }
    reopenJobFor(db, pact);
    if (getJob(db, j.id)!.status !== "AWARDED") changed++;
  }
  return changed;
}

/** Buyer withdraws an open job. Quotes are marked lost; nothing was reserved yet. */
export function cancelJob(db: Db, buyerId: string, jobId: string): JobRow {
  const job = getJob(db, jobId);
  if (!job) throw new JobError("not_found", "job not found");
  if (job.buyer_id !== buyerId) throw new JobError("forbidden", "not your job");
  if (job.status !== "OPEN") throw new JobError("state", `job is ${job.status}`);
  db.run("UPDATE jobs SET status = 'CLOSED', updated_at = ? WHERE id = ? AND status = 'OPEN'", [now(), jobId]);
  db.run("UPDATE quotes SET status = 'lost' WHERE job_id = ? AND status IN ('open', 'pending')", [jobId]);
  return getJob(db, jobId)!;
}

/** What the buyer bought: accepted items with their text; rejected ones with the verifier's reason. Owner-only at the route. */
export function deliverableFor(db: Db, pact: PactRow): { accepted: Array<{ sku: string; title: string; description: string }>; rejected: Array<{ sku: string; reason: string }>; status: PactRow["status"]; settled: boolean } {
  const art = db.query<{ body_json: string }, [string]>("SELECT body_json FROM artifacts WHERE pact_id = ?").get(pact.id);
  const items: Array<{ sku: string; title: string; description: string }> = art ? (JSON.parse(art.body_json) as unknown[]).filter((x): x is { sku: string; title: string; description: string } => Boolean(x && typeof x === "object" && "sku" in x)) : [];
  const verdicts = db
    .query<{ sku: string; verdict: string; reason: string; evidence_json: string }, [string]>("SELECT sku, verdict, reason, evidence_json FROM item_verdicts WHERE pact_id = ?")
    .all(pact.id)
    .map((v) => ({ sku: v.sku, verdict: v.verdict, reason: reasonText(v.reason, JSON.parse(v.evidence_json) as string[]) }));
  const settled = pact.status === "SETTLED" || pact.status === "PAID_OUT";
  const accepted = settled ? verdicts.filter((v) => v.verdict === "accepted").map((v) => items.find((i) => i.sku === v.sku)).filter((i): i is { sku: string; title: string; description: string } => Boolean(i)) : [];
  const rejected = verdicts.filter((v) => v.verdict === "rejected").map((v) => ({ sku: v.sku, reason: v.reason }));
  return { accepted, rejected, status: pact.status, settled };
}

/** Public job-board view: no items, no quotes. */
export function publicJob(db: Db, j: JobRow) {
  const buyer = db.query<{ name: string }, [string]>("SELECT name FROM users WHERE id = ?").get(j.buyer_id);
  const invited = j.agent_id ? getAgent(db, j.agent_id) : null;
  return {
    id: j.id,
    template: j.template,
    title: j.title,
    brief: j.brief,
    item_count: (JSON.parse(j.items_json) as unknown[]).length,
    max_unit_price_cents: j.max_unit_price_cents,
    status: j.status,
    buyer_name: buyer?.name ?? "",
    quote_count: db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM quotes WHERE job_id = ?").get(j.id)!.n,
    agent_id: j.agent_id,
    agent_name: invited?.name ?? null,
    created_at: j.created_at,
  };
}

/** The verifier's finding in plain words. Rubric verdicts store a score comparison as the reason; the sentence a person wants is in the evidence. */
export function reasonText(reason: string, evidence: string[]): string {
  if (!reason.startsWith("rubric ")) return reason;
  const finding = evidence.find((e) => !e.startsWith("quality "));
  const note = evidence.find((e) => e.startsWith("quality "))?.replace(/^quality \d\/5:\s*/, "");
  return finding ?? note ?? reason;
}

export interface MarketStats {
  totals: { pacts: number; items: number; accepted: number; capturedCents: number; releasedCents: number; paidOutCents: number; agents: number };
  recent: Array<{ title: string; agent_id: string | null; agent_name: string | null; item_count: number; accepted_count: number; unit_price_cents: number; authorized_cents: number; charge_cents: number; settlement_kind: string | null; settled_at: string }>;
}

/**
 * Marketplace totals and the latest settlements for the landing page. Marketplace pacts only (automated
 * demo runs are left out), and nothing beyond what the board and agent work histories already show:
 * titles, item counts, prices and outcomes, never items or delivered text.
 */
export function marketStats(db: Db, recentLimit = 6): MarketStats {
  const settled = "kind = 'market' AND status IN ('SETTLED', 'PAID_OUT')";
  const t = db
    .query<{ pacts: number; items: number; accepted: number; captured: number; released: number; paid: number }, []>(
      `SELECT count(*) AS pacts, coalesce(sum(item_count), 0) AS items, coalesce(sum(accepted_count), 0) AS accepted,
              coalesce(sum(charge_cents), 0) AS captured, coalesce(sum(coalesce(authorized_cents, 0) - coalesce(charge_cents, 0)), 0) AS released,
              coalesce(sum(CASE WHEN status = 'PAID_OUT' THEN charge_cents ELSE 0 END), 0) AS paid
       FROM pacts WHERE ${settled}`,
    )
    .get()!;
  const agents = db.query<{ n: number }, []>("SELECT count(*) AS n FROM agents WHERE status = 'active'").get()!.n;
  const rows = db.query<PactRow, [number]>(`SELECT * FROM pacts WHERE ${settled} ORDER BY updated_at DESC LIMIT ?`).all(recentLimit);
  return {
    totals: { pacts: t.pacts, items: t.items, accepted: t.accepted, capturedCents: t.captured, releasedCents: t.released, paidOutCents: t.paid, agents },
    recent: rows.map((p) => ({
      title: (JSON.parse(p.job_json) as { title: string }).title,
      agent_id: p.agent_id,
      agent_name: p.agent_id ? (getAgent(db, p.agent_id)?.name ?? null) : null,
      item_count: p.item_count,
      accepted_count: p.accepted_count ?? 0,
      unit_price_cents: p.unit_price_cents ?? 0,
      authorized_cents: p.authorized_cents ?? 0,
      charge_cents: p.charge_cents ?? 0,
      settlement_kind: p.settlement_kind,
      settled_at: p.updated_at,
    })),
  };
}

/** Buyer of the job, or a seller whose agent quoted it. */
export function canSeeJobDetails(db: Db, job: JobRow, userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (job.buyer_id === userId) return true;
  return Boolean(db.query<{ id: string }, [string, string]>("SELECT id FROM quotes WHERE job_id = ? AND seller_id = ?").get(job.id, userId));
}
