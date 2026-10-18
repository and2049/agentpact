import { describe, expect, test } from "bun:test";
import { sampleJob } from "../src/jobs/sample";
import type { Artifact } from "../src/pact/types";
import { factPresent, gate, verify, type Rubric } from "../src/verifier";
import { injectFault } from "../src/faults";
import { computeSettlement } from "../src/settlement";

const job = sampleJob("seller@example.com");

function goodArtifact(): Artifact {
  return job.skus.map((s) => {
    const facts = Object.entries(s.facts)
      .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
      .join(", ");
    const filler = "Built for long days on the trail, it packs small, sets up fast, and holds up season after season without fuss or extra weight on your back.";
    return { sku: s.sku, title: String(s.facts.name), description: `The ${s.facts.name} offers ${facts}. ${filler} ${filler}` };
  });
}

const alwaysGood: Rubric = async () => ({ score: 0.95, reasons: ["all facts present", "no invented claims"] });
const alwaysBad: Rubric = async () => ({ score: 0.2, reasons: ["invented award"] });

describe("factPresent", () => {
  test("strings case-insensitive, numbers as tokens", () => {
    expect(factPresent("Made of Carbon Fiber", "carbon fiber")).toBe(true);
    expect(factPresent("weighs 210 g", 210)).toBe(true);
    expect(factPresent("weighs 2100 g", 210)).toBe(false);
    expect(factPresent("rated 4.2", 4.2)).toBe(true);
    expect(factPresent("rated -7 C", -7)).toBe(true);
    expect(factPresent("rated 14.2", 4.2)).toBe(false);
  });
});

describe("gate", () => {
  test("accepts a well-formed artifact with no issues", () => {
    const g = gate(job, goodArtifact());
    expect(g.malformed).toBeNull();
    expect(g.items.size).toBe(20);
    for (const [, it] of g.items) expect(it.issues).toEqual([]);
  });
  test("short delivery is valid; missing items are simply absent", () => {
    const g = gate(job, goodArtifact().slice(0, 3));
    expect(g.malformed).toBeNull();
    expect(g.items.size).toBe(3);
  });
  test("string input is parsed", () => {
    expect(gate(job, JSON.stringify(goodArtifact())).malformed).toBeNull();
  });
  test("rejects unknown and duplicate skus, wrong shape, non-JSON", () => {
    const a = goodArtifact();
    expect(gate(job, [{ ...a[0]!, sku: "NOPE" }, ...a.slice(1)]).malformed).toMatch(/unknown sku/);
    expect(gate(job, [...a, { ...a[0]!, sku: "TRK-021" }]).malformed).toMatch(/schema/);
    expect(gate(job, [a[0]!, a[0]!]).malformed).toMatch(/duplicate/);
    expect(gate(job, { items: a }).malformed).toMatch(/schema/);
    expect(gate(job, "not json").malformed).toMatch(/schema/);
  });
  test("flags missing facts and word counts per item", () => {
    const a = goodArtifact();
    a[0]!.description = "Short text without the facts.";
    const g = gate(job, a);
    const issues = g.items.get("TRK-001")!.issues;
    expect(issues.some((i) => i.includes("carbon fiber"))).toBe(true);
    expect(issues.some((i) => i.startsWith("too short"))).toBe(true);
  });
});

describe("verify", () => {
  test("good artifact + good rubric -> all accepted, full settlement", async () => {
    const v = await verify(job, goodArtifact(), { rubric: alwaysGood });
    expect(v).toHaveLength(20);
    expect(v.every((x) => x.verdict === "accepted")).toBe(true);
    expect(computeSettlement({ verdicts: v, itemCount: 20, unitPriceCents: 100 }).kind).toBe("full");
  });
  test("rubric below threshold -> rejected with score", async () => {
    const v = await verify(job, goodArtifact(), { rubric: alwaysBad });
    expect(v.every((x) => x.verdict === "rejected" && x.score === 0.2)).toBe(true);
  });
  test("malformed -> all rejected, void settlement, rubric never called", async () => {
    let calls = 0;
    const counting: Rubric = async () => {
      calls++;
      return { score: 1, reasons: ["x"] };
    };
    const { raw } = injectFault(job, goodArtifact(), "broken");
    const v = await verify(job, raw, { rubric: counting });
    expect(calls).toBe(0);
    expect(v.every((x) => x.verdict === "rejected" && x.reason.startsWith("malformed"))).toBe(true);
    expect(computeSettlement({ verdicts: v, itemCount: 20, unitPriceCents: 100 }).kind).toBe("void");
  });
  test("partial fault -> dropped items missing, corrupted items fail the fact gate, rest accepted", async () => {
    const { raw, report } = injectFault(job, goodArtifact(), "partial");
    expect(report.dropped).toHaveLength(5);
    expect(report.corrupted.length).toBeGreaterThan(0);
    const v = await verify(job, raw, { rubric: alwaysGood });
    const by = Object.fromEntries(v.map((x) => [x.sku, x]));
    for (const sku of report.dropped) expect(by[sku]!.reason).toBe("missing");
    for (const c of report.corrupted) expect(by[c.sku]!.reason).toContain(`fact "${c.fact}"`);
    const s = computeSettlement({ verdicts: v, itemCount: 20, unitPriceCents: 100 });
    expect(s.kind).toBe("partial");
    expect(s.acceptedCount).toBe(20 - report.dropped.length - report.corrupted.length);
  });
  test("rubric failure rejects that item only", async () => {
    const flaky: Rubric = async ({ sku }) => {
      if (sku === "TRK-002") throw new Error("boom");
      return { score: 1, reasons: ["ok"] };
    };
    const v = await verify(job, goodArtifact(), { rubric: flaky, concurrency: 2 });
    expect(v.find((x) => x.sku === "TRK-002")!.reason).toMatch(/rubric unavailable/);
    expect(v.filter((x) => x.verdict === "accepted")).toHaveLength(19);
  });
  test("verdicts are in job order and onItem fires once per sku", async () => {
    const seen: string[] = [];
    const v = await verify(job, goodArtifact().slice(5), { rubric: alwaysGood, onItem: (x) => seen.push(x.sku) });
    expect(v.map((x) => x.sku)).toEqual(job.skus.map((s) => s.sku));
    expect(new Set(seen).size).toBe(20);
  });
});
