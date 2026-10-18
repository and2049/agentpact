import { describe, expect, test } from "bun:test";
import { computeSettlement } from "../src/settlement";
import type { ItemVerdict } from "../src/pact/types";
import { amountToCents, centsToAmount } from "../src/money";

const v = (sku: string, verdict: "accepted" | "rejected"): ItemVerdict => ({ sku, verdict, reason: "", score: null, evidence: [] });

describe("computeSettlement", () => {
  test("all accepted -> full", () => {
    const s = computeSettlement({ verdicts: [v("a", "accepted"), v("b", "accepted")], itemCount: 2, unitPriceCents: 150 });
    expect(s).toEqual({ kind: "full", acceptedCount: 2, rejectedCount: 0, chargeCents: 300, releasedCents: 0 });
  });
  test("some accepted -> partial, missing items earn zero", () => {
    const s = computeSettlement({ verdicts: [v("a", "accepted"), v("b", "rejected")], itemCount: 20, unitPriceCents: 100 });
    expect(s.kind).toBe("partial");
    expect(s.chargeCents).toBe(100);
    expect(s.releasedCents).toBe(1900);
    expect(s.rejectedCount).toBe(19);
  });
  test("none accepted -> void", () => {
    const s = computeSettlement({ verdicts: [], itemCount: 20, unitPriceCents: 100 });
    expect(s.kind).toBe("void");
    expect(s.chargeCents).toBe(0);
  });
  test("duplicate verdicts rejected", () => {
    expect(() => computeSettlement({ verdicts: [v("a", "accepted"), v("a", "accepted")], itemCount: 2, unitPriceCents: 1 })).toThrow(/duplicate/);
  });
  test("accepted beyond item count rejected", () => {
    expect(() => computeSettlement({ verdicts: [v("a", "accepted"), v("b", "accepted")], itemCount: 1, unitPriceCents: 1 })).toThrow(/exceeds/);
  });
});

describe("money", () => {
  test("round trips", () => {
    expect(centsToAmount(2000)).toBe("20.00");
    expect(centsToAmount(5)).toBe("0.05");
    expect(amountToCents("13.00")).toBe(1300);
    expect(amountToCents("1.5")).toBe(150);
    expect(amountToCents("18.99")).toBe(1899);
    expect(() => amountToCents("1.234")).toThrow();
    expect(() => centsToAmount(1.5)).toThrow();
  });
});
