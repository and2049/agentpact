import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createMandate, getMandate, MandateViolation, reserve, settleReservation } from "../src/mandate";
import { createPact } from "../src/pact/machine";
import { sampleJob, SELLER } from "./fixtures";

function setup() {
  const db = openDb();
  const m = createMandate(db, { maxPerPactCents: 1000, maxAggregateCents: 1500, allowedCategory: "product_descriptions", allowedSeller: SELLER });
  const p1 = createPact(db, m.id, sampleJob());
  const p2 = createPact(db, m.id, sampleJob());
  return { db, m, p1, p2 };
}

describe("mandate", () => {
  test("reserves within limits and tracks aggregate", () => {
    const { db, m, p1, p2 } = setup();
    reserve(db, { mandateId: m.id, pactId: p1.id, amountCents: 1000, category: "product_descriptions", seller: SELLER });
    expect(getMandate(db, m.id)!.reserved_cents).toBe(1000);
    expect(() => reserve(db, { mandateId: m.id, pactId: p2.id, amountCents: 600, category: "product_descriptions", seller: SELLER })).toThrow(MandateViolation);
    // nothing reserved on failure
    expect(getMandate(db, m.id)!.reserved_cents).toBe(1000);
    reserve(db, { mandateId: m.id, pactId: p2.id, amountCents: 500, category: "product_descriptions", seller: SELLER });
    expect(getMandate(db, m.id)!.reserved_cents).toBe(1500);
  });

  test("rejects per-pact, category and seller violations", () => {
    const { db, m, p1 } = setup();
    expect(() => reserve(db, { mandateId: m.id, pactId: p1.id, amountCents: 1001, category: "product_descriptions", seller: SELLER })).toThrow(/per-pact/);
    expect(() => reserve(db, { mandateId: m.id, pactId: p1.id, amountCents: 10, category: "other", seller: SELLER })).toThrow(/category/);
    expect(() => reserve(db, { mandateId: m.id, pactId: p1.id, amountCents: 10, category: "product_descriptions", seller: "x" })).toThrow(/seller/);
  });

  test("settling moves captured to spent, releases the hold, and is idempotent", () => {
    const { db, m, p1, p2 } = setup();
    reserve(db, { mandateId: m.id, pactId: p1.id, amountCents: 1000, category: "product_descriptions", seller: SELLER });
    settleReservation(db, { mandateId: m.id, pactId: p1.id, capturedCents: 300 });
    let mm = getMandate(db, m.id)!;
    expect(mm.reserved_cents).toBe(0);
    expect(mm.spent_cents).toBe(300);
    settleReservation(db, { mandateId: m.id, pactId: p1.id, capturedCents: 300 });
    mm = getMandate(db, m.id)!;
    expect(mm.spent_cents).toBe(300);
    // spent counts against the aggregate: 300 spent + 1000 new = 1300 ok, 1300 new = 1600 not ok
    reserve(db, { mandateId: m.id, pactId: p2.id, amountCents: 1000, category: "product_descriptions", seller: SELLER });
    expect(getMandate(db, m.id)!.reserved_cents).toBe(1000);
  });
});
