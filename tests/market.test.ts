import { describe, expect, test } from "bun:test";
import { upsertUser } from "../src/auth";
import { openDb } from "../src/db";
import { getMandate } from "../src/mandate";
import { createAgent, ensureSeedAgent, publicAgent, type AgentDeps } from "../src/market/agents";
import { awardJob, canSeeJobDetails, createJob, eligibleAgents, getJob, listQuotes, mandateForBuyer, recordQuote, reopenJobFor } from "../src/market/jobs";
import { getPact } from "../src/pact/machine";
import { completeCheckout, expireCheckouts } from "../src/payments/checkout";
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
    expect(eligibleAgents(db, job).map((a) => a.id)).toEqual([agent.id]);
    const q = recordQuote(db, job, agent, { unitPriceCents: 999, etaMinutes: 3, message: "hi" });
    expect(q.unit_price_cents).toBe(150); // clamped to the job max (agent band 50..200)
    expect(eligibleAgents(db, job)).toEqual([]); // already quoted
    const low = createJob(db, buyer.id, { template: "product_descriptions", title: "Cheap job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 10 });
    expect(eligibleAgents(db, low)).toEqual([]); // below the agent's minimum
    const own = createJob(db, seller.id, { template: "product_descriptions", title: "Seller's own job", brief: "Write a short, factual product description per SKU.", items: [{ sku: "A", facts: { name: "A" } }], maxUnitPriceCents: 100 });
    expect(eligibleAgents(db, own)).toEqual([]); // no self-dealing
  });

  test("award freezes the pact, reserves the buyer mandate and creates the approval order; duplicates are refused", async () => {
    const { db, buyer, seller, agent, flow, job, pp } = setup();
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
    await expect(awardJob({ db, flow }, { jobId: job.id, quoteId: q.id, buyerId: buyer.id })).rejects.toThrow(/AWARDED/);
    expect(pp.orders.size).toBe(1);
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
    expect(expired).toEqual([r.pact.id]);
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
    await expect(createAgent(deps, other.id, { name: "Free ride", description: "", provider: "platform", model: "", systemPrompt: "", minUnitPriceCents: 10, maxUnitPriceCents: 100, maxItemsPerJob: 20, maxQuotesPerDay: 20, status: "active" })).rejects.toThrow(/reserved/);
  });
});
