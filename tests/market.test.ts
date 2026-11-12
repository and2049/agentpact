import { describe, expect, test } from "bun:test";
import { upsertUser } from "../src/auth";
import { openDb } from "../src/db";
import { getMandate } from "../src/mandate";
import { AgentInput, AgentPatch, createAgent, ensureSeedAgent, getAgent, llmConfigForAgent, modelAllowed, publicAgent, updateAgent, type AgentDeps } from "../src/market/agents";
import { redactedError, redactSecrets } from "../src/redact";
import { awardJob, cancelJob, canSeeJobDetails, createJob, deliverableFor, eligibleAgents, getJob, JOB_LIMITS, jobSpecOf, listJobs, listQuotes, mandateForBuyer, marketStats, reasonText, recordQuote, reopenJobFor, reserveQuoteSlots } from "../src/market/jobs";
import { getPact } from "../src/pact/machine";
import { completeCheckout, expireCheckouts } from "../src/payments/checkout";
import { settlePact } from "../src/payments/flow";
import { transition } from "../src/pact/machine";
import type { FlowDeps } from "../src/payments/flow";
import { FakePayPal } from "./fake-paypal";
import { TEST_CARD } from "./fixtures";

function setup() {
  const db = openDb();
  const pp = new FakePayPal();
  const buyer = upsertUser(db, { provider: "paypal", providerUserId: "b1", name: "Buyer", email: "buyer@sb" });
  const seller = upsertUser(db, { provider: "dev", providerUserId: "seller", name: "Seller", email: "seller@sb" });
  const other = upsertUser(db, { provider: "paypal", providerUserId: "x1", name: "Other", email: "other@sb" });
  const agent = ensureSeedAgent(db, seller.id);
  const flow: FlowDeps = { db, paypal: pp, buyerCard: TEST_CARD, sellerEmail: "platform-fallback@sb" };
  const job = createJob(db, buyer.id, {
    template: "product_descriptions",
    title: "Three widgets",
    brief: "Write a short, factual product description per SKU.",
    items: [1, 2, 3].map((i) => ({ sku: `SKU-${i}`, facts: { name: `Widget ${i}`, material: "steel" } })),
    maxUnitPriceCents: 150,
  });
  return { db, pp, buyer, seller, other, agent, flow, job };
}

describe("marketplace", () => {
  test("eligible agents respect band, size, self-dealing and daily limits; quotes are clamped", () => {
    const { db, buyer, seller, agent, job } = setup();
    expect(eligibleAgents(db, job).map((a) => a.id)).toContain(agent.id);
    expect(eligibleAgents(db, job)).toHaveLength(3); // the three seeded personas
    const q = recordQuote(db, job, agent, { unitPriceCents: 999, etaMinutes: 3, message: "hi" });
    expect(q.unit_price_cents).toBe(150); // clamped to the job max (agent band 50..200)
    expect(eligibleAgents(db, job).map((a) => a.id)).not.toContain(agent.id); // already quoted
    const low = createJob(db, buyer.id, { template: "product_descriptions", title: "Cheap job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 10 });
    expect(eligibleAgents(db, low)).toEqual([]); // below the agent's minimum
    const own = createJob(db, seller.id, { template: "product_descriptions", title: "Seller's own job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 });
    expect(eligibleAgents(db, own)).toEqual([]); // no self-dealing
  });

  test("award freezes the pact, reserves the buyer mandate and creates the approval order; duplicates are refused", async () => {
    const { db, buyer, seller, other, agent, flow, job, pp } = setup();
    const q = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "Happy to." });
    const r = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    expect(r.checkout.ok).toBe(true);
    const pact = r.pact;
    expect(pact.status).toBe("AGREED");
    expect(pact.kind).toBe("market");
    expect(pact.order_id).toMatch(/^O/);
    expect(pact.buyer_id).toBe(buyer.id);
    expect(pact.seller_id).toBe(seller.id);
    expect(pact.payout_recipient).toBe("seller@sb");
    expect(JSON.parse(pact.frozen_json!).offer.unitPriceCents).toBe(100);
    expect(getJob(db, job.id)!.status).toBe("AWARDED");
    expect(listQuotes(db, job.id)[0]!.status).toBe("awarded");
    const m = mandateForBuyer(db, buyer.id);
    expect(m.reserved_cents).toBe(300);
    expect(m.allowed_seller).toBe("*");
    // Same quote again: idempotent (returns the same pact, no second order). A different quote: refused.
    const same = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    expect(same.pact.id).toBe(pact.id);
    expect(pp.orders.size).toBe(1);
    const agent2 = ensureSeedAgent(db, other.id);
    const q2 = recordQuote(db, job, agent2, { unitPriceCents: 90, etaMinutes: 3, message: "" });
    await expect(awardJob({ db, flow }, { jobId: job.id, quoteId: q2.id, buyerId: buyer.id })).rejects.toThrow(/AWARDED/);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM pacts").get()!.n).toBe(1);
  });

  test("only the buyer can award; a quote from another job is rejected", async () => {
    const { db, buyer, other, agent, flow, job } = setup();
    const q = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "" });
    await expect(awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: other.id })).rejects.toThrow(/not your job/);
    const job2 = createJob(db, buyer.id, { template: "product_descriptions", title: "Another job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 });
    await expect(awardJob({ db, flow }, { jobId: job2.id, quoteId: q.id, buyerId: buyer.id })).rejects.toThrow(/does not belong/);
  });

  test("approve after PayPal approval -> HELD with the frozen payout recipient; payout goes to the seller, not the platform default", async () => {
    const { db, buyer, agent, flow, job, pp } = setup();
    const q = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "" });
    const r = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    pp.approveOrder(r.pact.order_id!);
    const done = await completeCheckout(flow, r.pact.id, r.pact.order_id!);
    expect(done.ok && done.pact.status).toBe("HELD");
    expect(getPact(db, r.pact.id)!.payout_recipient).toBe("seller@sb");
  });

  test("checkout expiry reopens the job and releases the reservation", async () => {
    const { db, buyer, agent, flow, job } = setup();
    const q = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "" });
    const r = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    db.run("UPDATE pacts SET checkout_deadline = '2000-01-01T00:00:00.000Z' WHERE id = ?", [r.pact.id]);
    const expired = await expireCheckouts(flow);
    expect(expired.expired).toEqual([r.pact.id]);
    reopenJobFor(db, getPact(db, r.pact.id)!);
    expect(getJob(db, job.id)!.status).toBe("OPEN");
    expect(getJob(db, job.id)!.pact_id).toBeNull();
    expect(listQuotes(db, job.id)[0]!.status).toBe("open");
    expect(getMandate(db, mandateForBuyer(db, buyer.id).id)!.reserved_cents).toBe(0);
    // and a second award of the same quote works
    const r2 = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    expect(r2.checkout.ok).toBe(true);
  });

  test("job details are visible to the buyer and quoting sellers only", () => {
    const { db, buyer, seller, other, agent, job } = setup();
    expect(canSeeJobDetails(db, job, buyer.id)).toBe(true);
    expect(canSeeJobDetails(db, job, seller.id)).toBe(false);
    recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "" });
    expect(canSeeJobDetails(db, job, seller.id)).toBe(true);
    expect(canSeeJobDetails(db, job, other.id)).toBe(false);
    expect(canSeeJobDetails(db, job, null)).toBe(false);
  });

  test("agents: keyed providers need custody, keys never leave the API, platform provider is reserved", async () => {
    const { db, seller, other } = setup();
    const noCustody: AgentDeps = { db, env: {} };
    await expect(createAgent(noCustody, other.id, { name: "Mine", description: "", provider: "openai", model: "gpt-5.5", apiKey: "sk-test-1234567890", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 20, maxQuotesPerDay: 20, status: "active" })).rejects.toThrow(/custody/);
    const deps: AgentDeps = { db, env: { AGENT_KEY_SECRET: "test-secret" } };
    const a = await createAgent(deps, other.id, { name: "Mine", description: "", provider: "openai", model: "gpt-5.5", apiKey: "sk-test-1234567890", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 20, maxQuotesPerDay: 20, status: "active" });
    expect(a.api_key_enc).not.toContain("sk-test");
    const pub = publicAgent(db, a, other.id) as Record<string, unknown>;
    expect(JSON.stringify(pub)).not.toContain("sk-test");
    expect(pub.has_key).toBe(true);
    expect("has_key" in (publicAgent(db, a, seller.id) as Record<string, unknown>)).toBe(false);
    // platform-hosted agents: anyone, capped per user and in size
    const p1 = await createAgent(deps, other.id, { name: "Hosted one", description: "", provider: "platform", model: "", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 20, maxQuotesPerDay: 50, status: "active" });
    expect(p1.max_items_per_job).toBe(10);
    expect(p1.max_quotes_per_day).toBe(10);
    await createAgent(deps, other.id, { name: "Hosted two", description: "", provider: "platform", model: "", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 5, maxQuotesPerDay: 5, status: "active" });
    await expect(createAgent(deps, other.id, { name: "Hosted three", description: "", provider: "platform", model: "", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 5, maxQuotesPerDay: 5, status: "active" })).rejects.toThrow(/at most 2/);
  });

  test("award resume: order creation timed out -> second award call retries with the same op and does not create a second pact", async () => {
    const { db, buyer, agent, flow, job, pp } = setup();
    const q = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "" });
    pp.fault("createApprovalOrder", { kind: "timeout_before" });
    const r1 = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    expect(r1.checkout.ok).toBe(false);
    expect(!r1.checkout.ok && r1.checkout.code).toBe("unknown");
    expect(r1.pact.status).toBe("AGREED");
    expect(r1.pact.order_id).toBeNull();
    expect(getJob(db, job.id)!.status).toBe("AWARDED");
    const r2 = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    expect(r2.checkout.ok).toBe(true);
    expect(r2.pact.id).toBe(r1.pact.id);
    expect(r2.pact.order_id).toMatch(/^O/);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM pacts").get()!.n).toBe(1);
    expect(pp.orders.size).toBe(1);
  });

  test("quote slots are persisted before quoting and a resumed run fills only those", () => {
    const { db, seller, agent, job } = setup();
    const first = reserveQuoteSlots(db, job);
    expect(first.map((a) => a.id)).toContain(agent.id);
    expect(first).toHaveLength(3);
    expect(listQuotes(db, job.id).every((q) => q.status === "pending")).toBe(true);
    // another agent becomes eligible after the selection was made: not added to this job's selection
    const extra = ensureSeedAgent(db, upsertUser(db, { provider: "paypal", providerUserId: "late", name: "Late", email: "late@sb" }).id);
    const again = reserveQuoteSlots(db, job);
    expect(again.map((a) => a.id).sort()).toEqual(first.map((a) => a.id).sort());
    expect(again.map((a) => a.id)).not.toContain(extra.id);
    const filled = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "ok" });
    expect(filled.status).toBe("open");
    expect(reserveQuoteSlots(db, job).map((a) => a.id)).not.toContain(agent.id);
    expect(reserveQuoteSlots(db, job)).toHaveLength(2);
  });

  test("agent PATCH schema accepts partial bodies and validates the merged agent; model allowlist", async () => {
    const { db, other } = setup();
    expect(AgentPatch.safeParse({ status: "paused" }).success).toBe(true);
    expect(AgentPatch.safeParse({ minUnitPriceCents: -1 }).success).toBe(false);
    expect(modelAllowed("openai", "gpt-5.5")).toBe(true);
    expect(modelAllowed("openai", "claude-sonnet-5-5")).toBe(false);
    expect(modelAllowed("anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(AgentInput.safeParse({ name: "x1", provider: "openai", model: "llama-9", apiKey: "sk-test-1234567890", minUnitPriceCents: 1, maxUnitPriceCents: 2 }).success).toBe(false);
    const deps: AgentDeps = { db, env: { AGENT_KEY_SECRET: "test-secret" } };
    const a = await createAgent(deps, other.id, { name: "Mine", description: "", provider: "openai", model: "gpt-5.5", apiKey: "sk-test-1234567890", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 20, maxQuotesPerDay: 20, status: "active" });
    const paused = await updateAgent(deps, other.id, a.id, { status: "paused" });
    expect(paused.status).toBe("paused");
    expect(paused.description).toBe("");
    expect(paused.model).toBe("gpt-5.5");
    await expect(updateAgent(deps, other.id, a.id, { minUnitPriceCents: 500 })).rejects.toThrow();
    // frozen provider/model win over a later edit; the credential is current
    await updateAgent(deps, other.id, a.id, { model: "gpt-5.5-mini" });
    const cfg = await llmConfigForAgent(deps, (await updateAgent(deps, other.id, a.id, {})), { provider: "openai", model: "gpt-5.5" });
    expect(cfg.model).toBe("gpt-5.5");
    expect(cfg.apiKey).toBe("sk-test-1234567890");
  });

  test("redaction: a provider error echoing the credential never reaches persisted text", () => {
    const key = "sk-live-SENTINEL-0123456789abcdef";
    const e = redactedError(new Error(`401 Unauthorized: invalid api key ${key} for project`), [key]);
    expect(e.message).not.toContain("SENTINEL");
    expect(e.message).toContain("[redacted]");
    expect(redactSecrets("token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")).not.toContain("abcdefghijkl");
    expect(redactSecrets("order 5VC69492KA9111029 failed")).toContain("5VC69492KA9111029"); // short ids survive
  });

  test("pending quote slots are never awardable and survive award/reopen untouched", async () => {
    const { db, buyer, other, agent, flow, job } = setup();
    void other;
    reserveQuoteSlots(db, job); // the three seeded personas, all pending
    const q1 = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "" });
    const pending = listQuotes(db, job.id).find((q) => q.agent_id !== agent.id)!;
    expect(pending.status).toBe("pending");
    await expect(awardJob({ db, flow }, { jobId: job.id, quoteId: pending.id, buyerId: buyer.id })).rejects.toThrow(/pending|incomplete/);
    const r = await awardJob({ db, flow }, { jobId: job.id, quoteId: q1.id, buyerId: buyer.id });
    expect(listQuotes(db, job.id).filter((q) => q.agent_id !== agent.id).every((q) => q.status === "pending")).toBe(true);
    db.run("UPDATE pacts SET checkout_deadline = '2000-01-01T00:00:00.000Z' WHERE id = ?", [r.pact.id]);
    await expireCheckouts(flow);
    reopenJobFor(db, getPact(db, r.pact.id)!);
    expect(listQuotes(db, job.id).map((q) => q.status).sort()).toEqual(["open", "pending", "pending"]);
  });

  test("a stored key is bound to its provider: switching provider needs a new key, and a frozen pact refuses a mismatched key", async () => {
    const { db, other } = setup();
    const deps: AgentDeps = { db, env: { AGENT_KEY_SECRET: "test-secret" } };
    const a = await createAgent(deps, other.id, { name: "Mine", description: "", provider: "openai", model: "gpt-5.5", apiKey: "sk-openai-1234567890", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 20, maxQuotesPerDay: 20, status: "active" });
    expect(a.key_provider).toBe("openai");
    await expect(updateAgent(deps, other.id, a.id, { provider: "anthropic", model: "claude-sonnet-5-5" })).rejects.toThrow(/supply an apiKey for anthropic/);
    const b = await updateAgent(deps, other.id, a.id, { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-ant-abcdefghijklmnop" });
    expect(b.key_provider).toBe("anthropic");
    // the pact was frozen on openai: the anthropic key must never be sent to openai
    await expect(llmConfigForAgent(deps, b, { provider: "openai", model: "gpt-5.5" })).rejects.toThrow(/stored key is for anthropic/);
    const ok = await llmConfigForAgent(deps, b, { provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(ok.apiKey).toBe("sk-ant-abcdefghijklmnop");
    expect(AgentInput.safeParse({ name: "x1", provider: "openai", model: "gpt-5.5", apiKey: "short", minUnitPriceCents: 1, maxUnitPriceCents: 2 }).success).toBe(false);
  });

  test("legacy keyed agents: key_provider is migrated when unambiguous, otherwise the agent is not eligible", async () => {
    const { db, other, buyer } = setup();
    const deps: AgentDeps = { db, env: { AGENT_KEY_SECRET: "test-secret" } };
    const a = await createAgent(deps, other.id, { name: "Legacy", description: "", provider: "openai", model: "gpt-5.5", apiKey: "sk-openai-1234567890", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 20, maxQuotesPerDay: 20, status: "active" });
    db.run("UPDATE agents SET key_provider = NULL WHERE id = ?", [a.id]); // as a pre-migration row would look
    const job = createJob(db, buyer.id, { template: "product_descriptions", title: "Legacy job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 });
    expect(eligibleAgents(db, job).map((x) => x.id)).not.toContain(a.id); // ambiguous until re-keyed or migrated
    // an older open quote from that agent cannot be awarded, and a pending slot is not resumed
    db.run("INSERT INTO quotes (id, job_id, agent_id, seller_id, unit_price_cents, eta_minutes, message, status, created_at) VALUES ('legacy-q', ?, ?, ?, 50, 5, 'old', 'open', '2026-01-01')", [job.id, a.id, other.id]);
    const { awardJob: award } = await import("../src/market/jobs");
    const { FakePayPal: Fake } = await import("./fake-paypal");
    await expect(award({ db, flow: { db, paypal: new Fake(), buyerCard: TEST_CARD, sellerEmail: "x@sb" } }, { jobId: job.id, quoteId: "legacy-q", buyerId: buyer.id })).rejects.toThrow(/usable key/);
    db.run("UPDATE quotes SET status = 'pending' WHERE id = 'legacy-q'");
    expect(reserveQuoteSlots(db, job)).toEqual([]);
    db.run("DELETE FROM quotes WHERE id = 'legacy-q'");
    const { openDb: reopen } = await import("../src/db");
    void reopen; // the migration statement runs in openDb(); apply it directly here on the in-memory db
    db.run("UPDATE agents SET key_provider = provider WHERE api_key_enc IS NOT NULL AND key_provider IS NULL AND provider != 'platform' AND updated_at = created_at");
    expect(eligibleAgents(db, job).map((x) => x.id)).toContain(a.id);
  });

  test("provider and key changes wait until awarded pacts have delivered", async () => {
    const { db, other, buyer } = setup();
    const deps: AgentDeps = { db, env: { AGENT_KEY_SECRET: "test-secret" } };
    const a = await createAgent(deps, other.id, { name: "Busy", description: "", provider: "openai", model: "gpt-5.5", apiKey: "sk-openai-1234567890", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 20, maxQuotesPerDay: 20, status: "active" });
    const job = createJob(db, buyer.id, { template: "product_descriptions", title: "Busy job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 });
    db.run("INSERT INTO quotes (id, job_id, agent_id, seller_id, unit_price_cents, eta_minutes, message, status, created_at) VALUES ('busy-q', ?, ?, ?, 50, 5, 'ok', 'open', '2026-01-01')", [job.id, a.id, other.id]);
    const { awardJob: award } = await import("../src/market/jobs");
    const { FakePayPal: Fake } = await import("./fake-paypal");
    const { deleteAgentKey: delKey } = await import("../src/market/agents");
    const r = await award({ db, flow: { db, paypal: new Fake(), buyerCard: TEST_CARD, sellerEmail: "x@sb" } }, { jobId: job.id, quoteId: "busy-q", buyerId: buyer.id });
    expect(r.pact.status).toBe("AGREED");
    await expect(updateAgent(deps, other.id, a.id, { apiKey: "sk-openai-0987654321zz" })).rejects.toThrow(/still running/);
    await expect(updateAgent(deps, other.id, a.id, { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-ant-abcdefghijklmnop" })).rejects.toThrow(/still running/);
    expect(() => delKey(db, other.id, a.id)).toThrow(/still running/);
    const renamed = await updateAgent(deps, other.id, a.id, { name: "Busy but renamed", status: "paused" }); // non-credential edits are fine
    expect(renamed.name).toBe("Busy but renamed");
    db.run("UPDATE pacts SET status = 'DELIVERED' WHERE id = ?", [r.pact.id]);
    const b = await updateAgent(deps, other.id, a.id, { apiKey: "sk-openai-0987654321zz" });
    expect(b.key_provider).toBe("openai");
  });

  test("an award re-reads the agent inside its transaction: a key deleted during the hash await cannot be frozen", async () => {
    const { db, other, buyer } = setup();
    const deps: AgentDeps = { db, env: { AGENT_KEY_SECRET: "test-secret" } };
    const a = await createAgent(deps, other.id, { name: "Racy", description: "", provider: "openai", model: "gpt-5.5", apiKey: "sk-openai-1234567890", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 20, maxQuotesPerDay: 20, status: "active" });
    const job = createJob(db, buyer.id, { template: "product_descriptions", title: "Racy job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 });
    db.run("INSERT INTO quotes (id, job_id, agent_id, seller_id, unit_price_cents, eta_minutes, message, status, created_at) VALUES ('racy-q', ?, ?, ?, 50, 5, 'ok', 'open', '2026-01-01')", [job.id, a.id, other.id]);
    const { awardJob: award } = await import("../src/market/jobs");
    const { FakePayPal: Fake } = await import("./fake-paypal");
    const { deleteAgentKey: delKey } = await import("../src/market/agents");
    const pending = award({ db, flow: { db, paypal: new Fake(), buyerCard: TEST_CARD, sellerEmail: "x@sb" } }, { jobId: job.id, quoteId: "racy-q", buyerId: buyer.id });
    delKey(db, other.id, a.id); // lands while awardJob awaits the pact hash; no pact exists yet, so the guard lets it through
    await expect(pending).rejects.toThrow(/usable key/);
    expect(getJob(db, job.id)!.status).toBe("OPEN"); // nothing was committed
  });

  test("updateAgent decides from the row as it is after sealing, not the one read before", async () => {
    const { db, other, buyer } = setup();
    const deps: AgentDeps = { db, env: { AGENT_KEY_SECRET: "test-secret" } };
    const a = await createAgent(deps, other.id, { name: "Hosted", description: "", provider: "platform", model: "", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 10, maxQuotesPerDay: 10, status: "active" });
    // Update A starts (platform → anthropic) and parks at the seal await.
    const pendingA = updateAgent(deps, other.id, a.id, { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-ant-abcdefghijklmnop" });
    // Meanwhile the agent becomes an OpenAI agent and a pact is awarded on it (synchronous writes, as the server would do).
    db.run("UPDATE agents SET provider = 'openai', model = 'gpt-5.5', api_key_enc = 'sealed', key_provider = 'openai' WHERE id = ?", [a.id]);
    const { createPact: mkPact } = await import("../src/pact/machine");
    const job = createJob(db, buyer.id, { template: "product_descriptions", title: "Live job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 });
    const m = mandateForBuyer(db, buyer.id);
    const pact = mkPact(db, m.id, jobSpecOf(job, "x@sb"));
    db.run("UPDATE pacts SET agent_id = ?, status = 'AGREED', kind = 'market' WHERE id = ?", [a.id, pact.id]);
    // A resumes: the stale platform row must not let it overwrite the OpenAI credential the pact needs.
    await expect(pendingA).rejects.toThrow(/still running/);
    expect(getAgent(db, a.id)!.key_provider).toBe("openai");
  });

  test("reconcileJobs closes or reopens awarded jobs whose pacts already ended", async () => {
    const { db, other, buyer } = setup();
    const { reconcileJobs } = await import("../src/market/jobs");
    const { createPact: mkPact } = await import("../src/pact/machine");
    const mk = (title: string) => createJob(db, buyer.id, { template: "product_descriptions", title, brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 });
    const m = mandateForBuyer(db, buyer.id);
    const paid = mk("Paid"), expired = mk("Expired"), running = mk("Running"), orphan = mk("Orphan");
    for (const [j, status] of [[paid, "PAID_OUT"], [expired, "CHECKOUT_EXPIRED"], [running, "HELD"]] as const) {
      const p = mkPact(db, m.id, jobSpecOf(j, "x@sb"));
      db.run("UPDATE pacts SET status = ?, kind = 'market', job_id = ?, seller_id = ? WHERE id = ?", [status, j.id, other.id, p.id]);
      db.run("UPDATE jobs SET status = 'AWARDED', pact_id = ? WHERE id = ?", [p.id, j.id]);
    }
    db.run("UPDATE jobs SET status = 'AWARDED', pact_id = NULL WHERE id = ?", [orphan.id]);
    expect(reconcileJobs(db)).toBe(3);
    expect(getJob(db, paid.id)!.status).toBe("CLOSED");
    expect(getJob(db, expired.id)!.status).toBe("OPEN");
    expect(getJob(db, running.id)!.status).toBe("AWARDED");
    expect(getJob(db, orphan.id)!.status).toBe("OPEN");
    expect(reconcileJobs(db)).toBe(0); // idempotent
  });

  test("agent reputation counts settled marketplace pacts only, never fault-injected demo runs", async () => {
    const { db, buyer, agent, flow, job } = setup();
    const q = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "ok" });
    const { pact } = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    db.run("UPDATE pacts SET status = 'PAID_OUT', accepted_count = 2, charge_cents = 200 WHERE id = ?", [pact.id]);
    // A broken demo run by the same agent: 0 of 20 accepted.
    db.run(
      "INSERT INTO pacts (id, mandate_id, status, kind, agent_id, job_json, item_count, accepted_count, charge_cents, created_at, updated_at) SELECT 'demo-run', mandate_id, 'SETTLED', 'demo', agent_id, job_json, 20, 0, 0, created_at, updated_at FROM pacts WHERE id = ?",
      [pact.id],
    );
    expect(publicAgent(db, getAgent(db, agent.id)!).stats).toEqual({ settled: 1, items: 3, accepted: 2, acceptanceRate: 2 / 3, earnedCents: 200 });
  });

  test("direct hire: only the invited agent quotes, bad invitations are refused, and the job stays off the public board", () => {
    const { db, buyer, seller, agent, job } = setup();
    const base = { template: "product_descriptions" as const, title: "Direct order", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 150 };
    const hire = createJob(db, buyer.id, { ...base, agentId: agent.id });
    expect(hire.agent_id).toBe(agent.id);
    expect(eligibleAgents(db, hire).map((a) => a.id)).toEqual([agent.id]); // not the other two personas
    expect(reserveQuoteSlots(db, hire).map((a) => a.id)).toEqual([agent.id]);
    expect(eligibleAgents(db, job)).toHaveLength(3); // an open job still reaches everyone

    expect(() => createJob(db, buyer.id, { ...base, agentId: "nope" })).toThrow(/not available/);
    expect(() => createJob(db, seller.id, { ...base, agentId: agent.id })).toThrow(/your own agent/);
    expect(() => createJob(db, buyer.id, { ...base, maxUnitPriceCents: 10, agentId: agent.id })).toThrow(/starts at \$0\.50/);
    expect(() => createJob(db, buyer.id, { ...base, items: Array.from({ length: 20 }, (_, i) => ({ sku: `S${i}`, facts: { name: `N${i}` } })), agentId: agent.id })).not.toThrow();
    db.run("UPDATE agents SET status = 'paused' WHERE id = ?", [agent.id]);
    expect(() => createJob(db, buyer.id, { ...base, agentId: agent.id })).toThrow(/not available/);

    const board = listJobs(db, { status: "OPEN", board: true }).map((j) => j.id);
    expect(board).toContain(job.id);
    expect(board).not.toContain(hire.id);
    expect(listJobs(db, { buyerId: buyer.id }).map((j) => j.id)).toContain(hire.id); // the buyer still sees it
  });

  test("the public board leaves out jobs created by automated demo runs", async () => {
    const { db, buyer, agent, flow, job } = setup();
    const q = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "ok" });
    const { pact } = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    expect(listJobs(db, { status: "AWARDED", board: true }).map((j) => j.id)).toEqual([job.id]);
    db.run("UPDATE pacts SET kind = 'demo' WHERE id = ?", [pact.id]);
    expect(listJobs(db, { status: "AWARDED", board: true })).toEqual([]);
  });

  test("market stats: settled marketplace pacts only; captured, released and paid out add up", async () => {
    const { db, buyer, agent, flow, job } = setup();
    expect(marketStats(db).totals).toMatchObject({ pacts: 0, items: 0, capturedCents: 0, releasedCents: 0 });
    const q = recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "ok" });
    const { pact } = await awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id });
    expect(marketStats(db).totals.pacts).toBe(0); // awarded, not settled
    db.run("UPDATE pacts SET status = 'PAID_OUT', settlement_kind = 'partial', authorized_cents = 300, accepted_count = 2, charge_cents = 200 WHERE id = ?", [pact.id]);
    db.run(
      "INSERT INTO pacts (id, mandate_id, status, kind, agent_id, job_json, item_count, accepted_count, authorized_cents, charge_cents, created_at, updated_at) SELECT 'demo-run', mandate_id, 'SETTLED', 'demo', agent_id, job_json, 20, 0, 3000, 0, created_at, updated_at FROM pacts WHERE id = ?",
      [pact.id],
    );
    const s = marketStats(db);
    expect(s.totals).toEqual({ pacts: 1, items: 3, accepted: 2, capturedCents: 200, releasedCents: 100, paidOutCents: 200, agents: 3 });
    expect(s.recent).toHaveLength(1);
    expect(s.recent[0]).toMatchObject({ title: "Three widgets", agent_name: agent.name, item_count: 3, accepted_count: 2, authorized_cents: 300, charge_cents: 200, settlement_kind: "partial" });
  });

  test("reasonText: rubric verdicts read as the verifier's finding, gate verdicts are unchanged", () => {
    expect(reasonText("rubric 1.00 >= 0.6", ["quality 5/5: All four facts appear verbatim."])).toBe("All four facts appear verbatim.");
    expect(reasonText("rubric 0.00 < 0.6", ["invented claim: inflatable", "quality 3/5: Fine otherwise."])).toBe("invented claim: inflatable");
    expect(reasonText("rubric 0.60 >= 0.6", [])).toBe("rubric 0.60 >= 0.6");
    expect(reasonText("missing", [])).toBe("missing");
    expect(reasonText('fact "name" (Ember Camp Stove) not mentioned', ['fact "name" (Ember Camp Stove) not mentioned'])).toBe('fact "name" (Ember Camp Stove) not mentioned');
  });

  test("three seeded personas quote the same job; the buyer has a real choice", () => {
    const { db, seller, job } = setup();
    const agents = eligibleAgents(db, job);
    expect(agents.map((a) => a.name).sort()).toEqual(["Boutique Voice", "Budget Scribe", "Copywriter One"]); // all within band for a 150¢ max
    expect(agents.every((a) => a.owner_id === seller.id)).toBe(true);
    const cheap = createJob(db, job.buyer_id, { template: "product_descriptions", title: "Cheap job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 60 });
    expect(eligibleAgents(db, cheap).map((a) => a.name).sort()).toEqual(["Budget Scribe", "Copywriter One"]); // Boutique's minimum is above the max
  });

  test("job caps: per day and open at a time (not for seeded accounts)", () => {
    const { db, buyer } = setup();
    const input = { template: "product_descriptions" as const, title: "Capped job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 };
    for (let i = 1; i < JOB_LIMITS.open; i++) createJob(db, buyer.id, input, { enforceLimits: true }); // setup() already posted one
    expect(() => createJob(db, buyer.id, input, { enforceLimits: true })).toThrow(/open jobs/);
    createJob(db, buyer.id, input); // seeded/dev callers skip the limits
  });

  test("cancel: open only, quotes lost; close: job CLOSED when its pact pays out", async () => {
    const { db, buyer, agent, flow, job, pp } = setup();
    recordQuote(db, job, agent, { unitPriceCents: 100, etaMinutes: 3, message: "" });
    const closed = cancelJob(db, buyer.id, job.id);
    expect(closed.status).toBe("CLOSED");
    expect(listQuotes(db, job.id)[0]!.status).toBe("lost");
    expect(() => cancelJob(db, buyer.id, job.id)).toThrow(/CLOSED/);
    const job2 = createJob(db, buyer.id, { template: "product_descriptions", title: "Second", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 });
    const q = recordQuote(db, job2, agent, { unitPriceCents: 100, etaMinutes: 3, message: "" });
    const r = await awardJob({ db, flow }, { jobId: job2.id, quoteId: q.id, buyerId: buyer.id });
    pp.approveOrder(r.pact.order_id!);
    await completeCheckout(flow, r.pact.id, r.pact.order_id!);
    db.run("INSERT INTO artifacts (pact_id, body_json, submitted_at) VALUES (?, ?, '2026')", [r.pact.id, JSON.stringify([{ sku: "A", title: "A", description: "An A." }])]);
    transition(db, r.pact.id, "DELIVERED");
    db.run("INSERT INTO item_verdicts (pact_id, sku, verdict, reason, score, evidence_json) VALUES (?, 'A', 'accepted', 'ok', 1, '[]')", [r.pact.id]);
    transition(db, r.pact.id, "VERIFIED", { accepted_count: 1 });
    const settled = await settlePact(flow, r.pact.id, [{ sku: "A", verdict: "accepted", reason: "ok", score: 1, evidence: [] }]);
    expect(settled!.status).toBe("SETTLED");
    const d = deliverableFor(db, settled!);
    expect(d.accepted).toEqual([{ sku: "A", title: "A", description: "An A." }]);
    expect(d.rejected).toEqual([]);
    db.run("UPDATE pacts SET status = 'PAID_OUT' WHERE id = ?", [r.pact.id]);
    reopenJobFor(db, getPact(db, r.pact.id)!);
    expect(getJob(db, job2.id)!.status).toBe("CLOSED");
  });
});
