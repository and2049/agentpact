import { describe, expect, test } from "bun:test";
import { openDb, listEvents } from "../src/db";
import { createMandate, getMandate } from "../src/mandate";
import { createPact, transition } from "../src/pact/machine";
import type { ItemVerdict } from "../src/pact/types";
import { confirmCapture, confirmPayout, holdPact, payoutPact, settlePact, type FlowDeps } from "../src/payments/flow";
import { authorizationForPact, captureForPact, payoutForPact } from "../src/payments/resources";
import { FakePayPal } from "./fake-paypal";
import { sampleJob, SELLER, TEST_CARD } from "./fixtures";

const v = (sku: string, verdict: "accepted" | "rejected"): ItemVerdict => ({ sku, verdict, reason: "", score: null, evidence: [] });

function setup(opts: { maxAggregate?: number } = {}) {
  const db = openDb();
  const pp = new FakePayPal();
  const m = createMandate(db, { maxPerPactCents: 10_000, maxAggregateCents: opts.maxAggregate ?? 10_000, allowedCategory: "product_descriptions", allowedSeller: SELLER });
  const p = createPact(db, m.id, sampleJob(3));
  transition(db, p.id, "OFFERED", { offer_json: JSON.stringify({ unitPriceCents: 100, etaMinutes: 5, note: "" }), unit_price_cents: 100 });
  transition(db, p.id, "AGREED");
  const deps: FlowDeps = { db, paypal: pp, buyerCard: TEST_CARD, sellerEmail: SELLER };
  return { db, pp, m, p, deps };
}

async function heldAndVerified(verdicts: ItemVerdict[]) {
  const s = setup();
  await holdPact(s.deps, s.p.id);
  transition(s.db, s.p.id, "DELIVERED");
  transition(s.db, s.p.id, "VERIFIED");
  return { ...s, verdicts };
}

describe("hold", () => {
  test("AGREED -> HELD with authorization row and mandate reservation", async () => {
    const { db, deps, p, m } = setup();
    const r = await holdPact(deps, p.id);
    expect(r!.status).toBe("HELD");
    expect(r!.authorized_cents).toBe(300);
    expect(authorizationForPact(db, p.id)!.status).toBe("CREATED");
    expect(getMandate(db, m.id)!.reserved_cents).toBe(300);
  });

  test("mandate violation -> HOLD_FAILED, no PayPal call", async () => {
    const { db, deps, p, pp } = setup({ maxAggregate: 100 });
    const r = await holdPact(deps, p.id);
    expect(r!.status).toBe("HOLD_FAILED");
    expect(pp.calls).toEqual([]);
    expect(listEvents(db, p.id).some((e) => e.type === "mandate.violation")).toBe(true);
  });

  test("http failure -> HOLD_FAILED and reservation released", async () => {
    const { db, deps, p, pp, m } = setup();
    pp.fault("createCardAuthorizedOrder", { kind: "http", status: 422 });
    const r = await holdPact(deps, p.id);
    expect(r!.status).toBe("HOLD_FAILED");
    expect(getMandate(db, m.id)!.reserved_cents).toBe(0);
  });

  test("timeout -> stays AGREED with reservation held; retry replays same request", async () => {
    const { db, deps, p, pp, m } = setup();
    pp.fault("createCardAuthorizedOrder", { kind: "timeout_after_success" });
    const r1 = await holdPact(deps, p.id);
    expect(r1!.status).toBe("AGREED");
    expect(getMandate(db, m.id)!.reserved_cents).toBe(300);
    const r2 = await holdPact(deps, p.id);
    expect(r2!.status).toBe("HELD");
    expect(pp.auths.size).toBe(1);
    expect(getMandate(db, m.id)!.reserved_cents).toBe(300);
  });
});

describe("settle", () => {
  test("all accepted -> full capture -> SETTLED, spent = charge", async () => {
    const s = await heldAndVerified([v("SKU-1", "accepted"), v("SKU-2", "accepted"), v("SKU-3", "accepted")]);
    const r = await settlePact(s.deps, s.p.id, s.verdicts);
    expect(r!.status).toBe("SETTLED");
    expect(r!.settlement_kind).toBe("full");
    expect(r!.charge_cents).toBe(300);
    expect(captureForPact(s.db, s.p.id)!.status).toBe("COMPLETED");
    const m = getMandate(s.db, s.m.id)!;
    expect(m.reserved_cents).toBe(0);
    expect(m.spent_cents).toBe(300);
  });

  test("some accepted -> partial final capture of accepted × unit", async () => {
    const s = await heldAndVerified([v("SKU-1", "accepted"), v("SKU-2", "rejected")]); // SKU-3 missing
    const r = await settlePact(s.deps, s.p.id, s.verdicts);
    expect(r!.status).toBe("SETTLED");
    expect(r!.settlement_kind).toBe("partial");
    expect(r!.charge_cents).toBe(100);
    expect(captureForPact(s.db, s.p.id)!.amount_cents).toBe(100);
    expect(captureForPact(s.db, s.p.id)!.final_capture).toBe(1);
    expect(getMandate(s.db, s.m.id)!.spent_cents).toBe(100);
  });

  test("none accepted -> void -> SETTLED with zero charge", async () => {
    const s = await heldAndVerified([v("SKU-1", "rejected")]);
    const r = await settlePact(s.deps, s.p.id, s.verdicts);
    expect(r!.status).toBe("SETTLED");
    expect(r!.settlement_kind).toBe("void");
    expect(authorizationForPact(s.db, s.p.id)!.status).toBe("VOIDED");
    expect(captureForPact(s.db, s.p.id)).toBeNull();
    expect(getMandate(s.db, s.m.id)!.spent_cents).toBe(0);
    expect(getMandate(s.db, s.m.id)!.reserved_cents).toBe(0);
  });

  test("PENDING capture keeps SETTLING until COMPLETED; payout refused meanwhile", async () => {
    const s = await heldAndVerified([v("SKU-1", "accepted"), v("SKU-2", "accepted"), v("SKU-3", "accepted")]);
    s.pp.captureStatus = "PENDING";
    const r = await settlePact(s.deps, s.p.id, s.verdicts);
    expect(r!.status).toBe("SETTLING");
    expect(getMandate(s.db, s.m.id)!.reserved_cents).toBe(300);
    await expect(payoutPact(s.deps, s.p.id)).rejects.toThrow(/cannot pay out/);
    const r2 = await confirmCapture(s.deps, s.p.id);
    expect(r2!.status).toBe("SETTLING");
    s.pp.completeCapture(captureForPact(s.db, s.p.id)!.id, "COMPLETED");
    const r3 = await confirmCapture(s.deps, s.p.id);
    expect(r3!.status).toBe("SETTLED");
    expect(getMandate(s.db, s.m.id)!.spent_cents).toBe(300);
  });

  test("DECLINED capture -> SETTLEMENT_FAILED", async () => {
    const s = await heldAndVerified([v("SKU-1", "accepted"), v("SKU-2", "accepted"), v("SKU-3", "accepted")]);
    s.pp.captureStatus = "DECLINED";
    const r = await settlePact(s.deps, s.p.id, s.verdicts);
    expect(r!.status).toBe("SETTLEMENT_FAILED");
  });

  test("capture timeout -> stays SETTLING; retry replays, one capture only", async () => {
    const s = await heldAndVerified([v("SKU-1", "accepted"), v("SKU-2", "accepted"), v("SKU-3", "accepted")]);
    s.pp.fault("captureAuthorization", { kind: "timeout_after_success" });
    const r1 = await settlePact(s.deps, s.p.id, s.verdicts);
    expect(r1!.status).toBe("SETTLING");
    const r2 = await settlePact(s.deps, s.p.id, s.verdicts);
    expect(r2!.status).toBe("SETTLED");
    expect(s.pp.captures.size).toBe(1);
  });

  test("void timeout reconciles by reading the authorization", async () => {
    const s = await heldAndVerified([]);
    s.pp.fault("voidAuthorization", { kind: "timeout_after_success" });
    const r = await settlePact(s.deps, s.p.id, s.verdicts);
    expect(r!.status).toBe("SETTLED");
    expect(r!.settlement_kind).toBe("void");
  });

  test("settlement decision is made once: second call with different verdicts does not change the charge", async () => {
    const s = await heldAndVerified([v("SKU-1", "accepted")]);
    s.pp.fault("captureAuthorization", { kind: "timeout_before" });
    await settlePact(s.deps, s.p.id, s.verdicts);
    const r = await settlePact(s.deps, s.p.id, [v("SKU-1", "accepted"), v("SKU-2", "accepted"), v("SKU-3", "accepted")]);
    expect(r!.charge_cents).toBe(100);
    expect(captureForPact(s.db, s.p.id)!.amount_cents).toBe(100);
  });
});

describe("payout", () => {
  test("SETTLED -> PAID_OUT when the payout item is SUCCESS", async () => {
    const s = await heldAndVerified([v("SKU-1", "accepted"), v("SKU-2", "accepted"), v("SKU-3", "accepted")]);
    await settlePact(s.deps, s.p.id, s.verdicts);
    const r = await payoutPact(s.deps, s.p.id);
    expect(r!.status).toBe("PAID_OUT");
    const po = payoutForPact(s.db, s.p.id)!;
    expect(po.amount_cents).toBe(300);
    expect(po.receiver).toBe(SELLER);
  });

  test("PENDING payout item stays SETTLED until SUCCESS; no second payout on retry", async () => {
    const s = await heldAndVerified([v("SKU-1", "accepted"), v("SKU-2", "accepted"), v("SKU-3", "accepted")]);
    await settlePact(s.deps, s.p.id, s.verdicts);
    s.pp.payoutItemStatus = "PENDING";
    const r1 = await payoutPact(s.deps, s.p.id);
    expect(r1!.status).toBe("SETTLED");
    const r2 = await payoutPact(s.deps, s.p.id);
    expect(r2!.status).toBe("SETTLED");
    expect(s.pp.payouts.size).toBe(1);
    s.pp.setPayoutItemStatus(payoutForPact(s.db, s.p.id)!.batch_id, "SUCCESS");
    const r3 = await confirmPayout(s.deps, s.p.id);
    expect(r3!.status).toBe("PAID_OUT");
  });

  test("void settlement has nothing to pay out", async () => {
    const s = await heldAndVerified([]);
    await settlePact(s.deps, s.p.id, s.verdicts);
    await expect(payoutPact(s.deps, s.p.id)).rejects.toThrow(/nothing to pay out/);
  });
});
