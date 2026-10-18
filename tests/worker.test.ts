import { describe, expect, test } from "bun:test";
import { listEvents, openDb } from "../src/db";
import { sampleJob } from "../src/jobs/sample";
import { createMandate, getMandate } from "../src/mandate";
import { preparePact } from "../src/pact/run";
import type { Agents } from "../src/pact/stages";
import { getPact } from "../src/pact/machine";
import type { Artifact } from "../src/pact/types";
import { enqueue, listTasks, withPactLock, Worker } from "../src/worker";
import { FakePayPal } from "./fake-paypal";
import { SELLER, TEST_CARD } from "./fixtures";

function artifactFor(job: ReturnType<typeof sampleJob>): Artifact {
  const filler = "Built for long days on the trail, it packs small, sets up fast, and holds up season after season without fuss or extra weight on your back.";
  return job.skus.map((s) => ({ sku: s.sku, title: String(s.facts.name), description: `The ${s.facts.name} offers ${Object.entries(s.facts).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}. ${filler} ${filler}` }));
}
const stubAgents = (job: ReturnType<typeof sampleJob>): Agents => ({
  quote: async () => ({ unitPriceCents: 100, etaMinutes: 5, message: "Happy to take this on." }),
  decide: async () => ({ accept: true, message: "Accepted." }),
  produce: async () => artifactFor(job),
  rubric: async () => ({ score: 0.9, reasons: ["ok"] }),
});

function setup() {
  const db = openDb();
  const pp = new FakePayPal();
  const m = createMandate(db, { maxPerPactCents: 5000, maxAggregateCents: 20000, allowedCategory: "product_descriptions", allowedSeller: SELLER });
  const job = sampleJob(SELLER);
  const flow = { db, paypal: pp, buyerCard: TEST_CARD, sellerEmail: SELLER };
  const terminal: string[] = [];
  const worker = new Worker(db, { flow, agentsFor: () => stubAgents(job), pollMs: 1, sweepMs: 1, onTerminal: (p) => terminal.push(p.status) });
  return { db, pp, m, job, flow, worker, terminal };
}

async function drain(w: Worker, max = 200) {
  for (let i = 0; i < max; i++) {
    const did = await w.tick();
    if (!did) await Bun.sleep(2);
  }
}

describe("worker", () => {
  test("enqueue is idempotent per (subject, kind) and pulls an earlier run_after forward", () => {
    const { db } = setup();
    const a = enqueue(db, "p1", "advance", 10_000);
    const b = enqueue(db, "p1", "advance", 0);
    expect(b.id).toBe(a.id);
    expect(b.run_after <= new Date().toISOString()).toBe(true);
    expect(listTasks(db, "p1")).toHaveLength(1);
  });

  test("drives a demo pact through every stage to PAID_OUT, one stage per tick", async () => {
    const { db, m, job, worker, terminal } = setup();
    const p = preparePact(db, { mandateId: m.id, job, scenario: "good" });
    enqueue(db, p.id, "advance");
    const statuses: string[] = [];
    for (let i = 0; i < 40; i++) {
      const did = await worker.tick();
      statuses.push(getPact(db, p.id)!.status);
      if (!did) break;
    }
    expect(getPact(db, p.id)!.status).toBe("PAID_OUT");
    expect(statuses).toContain("HELD");
    expect(statuses).toContain("DELIVERED");
    expect(statuses).toContain("VERIFIED");
    expect(terminal).toEqual(["PAID_OUT"]);
    expect(listEvents(db, p.id).some((e) => e.type === "run.finished")).toBe(true);
    expect(getMandate(db, m.id)!.spent_cents).toBe(2000);
  });

  test("restart after authorization: a new worker recovers the pact and finishes with exactly one capture and one payout", async () => {
    const { db, m, job, worker, flow, pp } = setup();
    const p = preparePact(db, { mandateId: m.id, job, scenario: "good" });
    enqueue(db, p.id, "advance");
    while (getPact(db, p.id)!.status !== "HELD") await worker.tick();
    // simulate a crash: the next task was claimed but never finished
    db.run("UPDATE tasks SET status = 'running' WHERE subject_id = ?", [p.id]);
    const w2 = new Worker(db, { flow, agentsFor: () => stubAgents(job), pollMs: 1 });
    const rec = w2.recover();
    expect(rec.requeued).toBe(1);
    await drain(w2, 40);
    expect(getPact(db, p.id)!.status).toBe("PAID_OUT");
    expect(pp.captures.size).toBe(1);
    expect(pp.payouts.size).toBe(1);
  });

  test("recover() re-queues live pacts that have no task, but not market pacts waiting on the buyer", () => {
    const { db, m, job, worker } = setup();
    const a = preparePact(db, { mandateId: m.id, job, scenario: "good" });
    db.run("UPDATE pacts SET status = 'VERIFIED' WHERE id = ?", [a.id]);
    const b = preparePact(db, { mandateId: m.id, job, scenario: "good" });
    db.run("UPDATE pacts SET status = 'AGREED', kind = 'market', order_id = 'O1' WHERE id = ?", [b.id]);
    const rec = worker.recover();
    expect(rec.pacts).toEqual([a.id]);
    expect(listTasks(db, b.id)).toEqual([]);
    expect(listTasks(db, "*").some((t) => t.kind === "sweep")).toBe(true);
  });

  test("pending capture: stays SETTLING and polls; a late COMPLETED capture yields exactly one payout", async () => {
    const { db, m, job, worker, pp } = setup();
    pp.captureStatus = "PENDING";
    const p = preparePact(db, { mandateId: m.id, job, scenario: "good" });
    enqueue(db, p.id, "advance");
    for (let i = 0; i < 12; i++) await worker.tick();
    expect(getPact(db, p.id)!.status).toBe("SETTLING");
    expect(pp.payouts.size).toBe(0);
    await Bun.sleep(3);
    await worker.tick();
    expect(getPact(db, p.id)!.status).toBe("SETTLING");
    pp.completeCapture([...pp.captures.keys()][0]!);
    await drain(worker, 20);
    expect(getPact(db, p.id)!.status).toBe("PAID_OUT");
    expect(pp.payouts.size).toBe(1);
    // a stray extra advance (e.g. from a webhook) changes nothing
    enqueue(db, p.id, "advance");
    await drain(worker, 5);
    expect(pp.payouts.size).toBe(1);
    expect(pp.captures.size).toBe(1);
  });

  test("a stage that throws is retried with backoff and gives up after 5 attempts with run.error", async () => {
    const { db, m, job, flow } = setup();
    let calls = 0;
    const agents: Agents = { ...stubAgents(job), produce: async () => { calls++; throw new Error("model down"); } };
    const w = new Worker(db, { flow, agentsFor: () => agents, pollMs: 1 });
    const p = preparePact(db, { mandateId: m.id, job, scenario: "good" });
    enqueue(db, p.id, "advance");
    while (getPact(db, p.id)!.status !== "HELD") await w.tick();
    for (let i = 0; i < 6; i++) {
      db.run("UPDATE tasks SET run_after = '2000-01-01' WHERE subject_id = ?", [p.id]); // skip the backoff
      await w.tick();
    }
    expect(calls).toBe(5);
    const t = listTasks(db, p.id)[0]!;
    expect(t.status).toBe("failed");
    expect(t.last_error).toContain("model down");
    const ev = listEvents(db, p.id).map((e) => e.type);
    expect(ev.filter((t) => t === "run.retry")).toHaveLength(4);
    expect(ev).toContain("run.error");
    expect(ev[ev.length - 1]).toBe("run.finished");
  });

  test("withPactLock serializes work on one pact", async () => {
    const order: string[] = [];
    const a = withPactLock("p", async () => { await Bun.sleep(10); order.push("a"); });
    const b = withPactLock("p", async () => { order.push("b"); });
    const c = withPactLock("q", async () => { order.push("c"); });
    await Promise.all([a, b, c]);
    expect(order).toEqual(["c", "a", "b"]);
  });
});
