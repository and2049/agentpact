import { describe, expect, test } from "bun:test";
import { listEvents, openDb } from "../src/db";
import { sampleJob } from "../src/jobs/sample";
import { createMandate, getMandate } from "../src/mandate";
import { runPact, type Agents, type RunDeps } from "../src/pact/run";
import type { Artifact } from "../src/pact/types";
import { FakePayPal } from "./fake-paypal";
import { SELLER, TEST_CARD } from "./fixtures";

function artifactFor(job: ReturnType<typeof sampleJob>): Artifact {
  const filler = "Built for long days on the trail, it packs small, sets up fast, and holds up season after season without fuss or extra weight on your back.";
  return job.skus.map((s) => ({
    sku: s.sku,
    title: String(s.facts.name),
    description: `The ${s.facts.name} offers ${Object.entries(s.facts).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}. ${filler} ${filler}`,
  }));
}

function stubAgents(job: ReturnType<typeof sampleJob>, unitPriceCents = 100, accept = true): Agents {
  return {
    quote: async () => ({ unitPriceCents, etaMinutes: 5, message: "Happy to take this on." }),
    decide: async () => ({ accept, message: accept ? "Accepted." : "Too expensive." }),
    produce: async (_j, onBatch) => {
      const a = artifactFor(job);
      onBatch?.(a.slice(0, 5));
      return a;
    },
    rubric: async () => ({ score: 0.9, reasons: ["ok"] }),
  };
}

function setup(opts: { perPact?: number } = {}) {
  const db = openDb();
  const pp = new FakePayPal();
  const m = createMandate(db, { maxPerPactCents: opts.perPact ?? 5000, maxAggregateCents: 20000, allowedCategory: "product_descriptions", allowedSeller: SELLER });
  const job = sampleJob(SELLER);
  const deps: RunDeps = { flow: { db, paypal: pp, buyerCard: TEST_CARD, sellerEmail: SELLER }, agents: stubAgents(job), pollMs: 1, maxPolls: 5 };
  return { db, pp, m, job, deps };
}

describe("runPact", () => {
  test("good scenario -> PAID_OUT, full capture, transcript has all roles", async () => {
    const { db, deps, m, job } = setup();
    const p = await runPact(deps, { mandateId: m.id, job, scenario: "good" });
    expect(p.status).toBe("PAID_OUT");
    expect(p.settlement_kind).toBe("full");
    expect(p.charge_cents).toBe(2000);
    const ev = listEvents(db, p.id);
    const roles = new Set(ev.filter((e) => e.type === "agent.message").map((e) => JSON.parse(e.payload_json).role));
    expect([...roles].sort()).toEqual(["buyer", "platform", "seller", "verifier"]);
    expect(ev.filter((e) => e.type === "verifier.item")).toHaveLength(20);
    expect(getMandate(db, m.id)!.spent_cents).toBe(2000);
    const stored = db.query<{ n: number }, [string]>("SELECT count(*) as n FROM item_verdicts WHERE pact_id = ?").get(p.id)!.n;
    expect(stored).toBe(20);
  });

  test("partial scenario -> partial capture of accepted items only", async () => {
    const { deps, m, job } = setup();
    const p = await runPact(deps, { mandateId: m.id, job, scenario: "partial" });
    expect(p.status).toBe("PAID_OUT");
    expect(p.settlement_kind).toBe("partial");
    expect(p.accepted_count).toBe(12);
    expect(p.charge_cents).toBe(1200);
  });

  test("broken scenario -> void, nothing charged, no payout", async () => {
    const { deps, m, job, pp } = setup();
    const p = await runPact(deps, { mandateId: m.id, job, scenario: "broken" });
    expect(p.status).toBe("SETTLED");
    expect(p.settlement_kind).toBe("void");
    expect(p.charge_cents).toBe(0);
    expect(pp.payouts.size).toBe(0);
  });

  test("server rejects a quote above the job max even if the buyer agent accepts", async () => {
    const { deps, m, job, pp } = setup();
    deps.agents = stubAgents(job, 999, true);
    const p = await runPact(deps, { mandateId: m.id, job, scenario: "good" });
    expect(p.status).toBe("REJECTED");
    expect(pp.calls).toEqual([]);
  });

  test("server rejects a total above the mandate per-pact limit", async () => {
    const { deps, m, job, pp } = setup({ perPact: 1500 });
    const p = await runPact(deps, { mandateId: m.id, job, scenario: "good" });
    expect(p.status).toBe("REJECTED");
    expect(pp.calls).toEqual([]);
  });

  test("buyer agent may reject on its own", async () => {
    const { deps, m, job } = setup();
    deps.agents = stubAgents(job, 100, false);
    const p = await runPact(deps, { mandateId: m.id, job, scenario: "good" });
    expect(p.status).toBe("REJECTED");
  });
});
