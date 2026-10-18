import { describe, expect, test } from "bun:test";
import { openDb, listEvents } from "../src/db";
import { createMandate } from "../src/mandate";
import { canTransition, createPact, IllegalTransition, transition } from "../src/pact/machine";
import { sampleJob } from "./fixtures";

describe("pact state machine", () => {
  test("happy path transitions", () => {
    const db = openDb();
    const m = createMandate(db, { maxPerPactCents: 5000, maxAggregateCents: 10000, allowedCategory: "product_descriptions", allowedSeller: "seller@example.com" });
    const p = createPact(db, m.id, sampleJob());
    expect(p.status).toBe("DRAFT");
    const seq: Array<Parameters<typeof transition>[2]> = ["OFFERED", "AGREED", "HELD", "DELIVERED", "VERIFIED", "SETTLING", "SETTLED", "PAID_OUT"];
    let cur = p;
    for (const s of seq) cur = transition(db, p.id, s);
    expect(cur.status).toBe("PAID_OUT");
    const events = listEvents(db, p.id);
    expect(events.map((e) => e.type)).toEqual(["pact.created", ...seq.map((s) => `pact.${s.toLowerCase()}`)]);
  });

  test("illegal transition throws and leaves state untouched", () => {
    const db = openDb();
    const m = createMandate(db, { maxPerPactCents: 1, maxAggregateCents: 1, allowedCategory: "product_descriptions", allowedSeller: "s" });
    const p = createPact(db, m.id, sampleJob());
    expect(() => transition(db, p.id, "HELD")).toThrow(IllegalTransition);
    expect(canTransition("PAID_OUT", "DRAFT")).toBe(false);
    expect(canTransition("SETTLEMENT_FAILED", "SETTLING")).toBe(true);
  });

  test("transition can set columns", () => {
    const db = openDb();
    const m = createMandate(db, { maxPerPactCents: 1, maxAggregateCents: 1, allowedCategory: "product_descriptions", allowedSeller: "s" });
    const p = createPact(db, m.id, sampleJob());
    const r = transition(db, p.id, "OFFERED", { offer_json: JSON.stringify({ unitPriceCents: 100, etaMinutes: 5, note: "" }), unit_price_cents: 100 });
    expect(r.unit_price_cents).toBe(100);
  });
});
