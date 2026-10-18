import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createMandate, getMandate } from "../src/mandate";
import { createPact, transition } from "../src/pact/machine";
import { beginCheckout, completeCheckout, expireCheckouts } from "../src/payments/checkout";
import type { FlowDeps } from "../src/payments/flow";
import { settlePact } from "../src/payments/flow";
import { authorizationForPact } from "../src/payments/resources";
import { FakePayPal } from "./fake-paypal";
import { sampleJob, SELLER, TEST_CARD } from "./fixtures";

function setup() {
  const db = openDb();
  const pp = new FakePayPal();
  const m = createMandate(db, { maxPerPactCents: 10_000, maxAggregateCents: 10_000, allowedCategory: "product_descriptions", allowedSeller: SELLER });
  const p = createPact(db, m.id, sampleJob(3));
  transition(db, p.id, "OFFERED", { offer_json: JSON.stringify({ unitPriceCents: 100, etaMinutes: 5, note: "" }), unit_price_cents: 100 });
  transition(db, p.id, "AGREED");
  const deps: FlowDeps = { db, paypal: pp, buyerCard: TEST_CARD, sellerEmail: SELLER };
  return { db, pp, m, p, deps };
}

describe("checkout hold path", () => {
  test("begin creates an approval order and reserves; pact stays AGREED", async () => {
    const { db, deps, p, m } = setup();
    const r = await beginCheckout(deps, p.id);
    expect(r.ok).toBe(true);
    const pact = r.ok ? r.pact : null;
    expect(pact!.status).toBe("AGREED");
    expect(pact!.order_id).toMatch(/^O/);
    expect(pact!.checkout_deadline).toBeTruthy();
    expect(getMandate(db, m.id)!.reserved_cents).toBe(300);
    // idempotent
    const r2 = await beginCheckout(deps, p.id);
    expect(r2.ok && r2.pact.order_id).toBe(pact!.order_id);
    expect(deps.paypal instanceof FakePayPal && (deps.paypal as FakePayPal).orders.size).toBe(1);
  });

  test("complete before approval -> not_approved, pact still AGREED, retry after approval -> HELD", async () => {
    const { db, deps, p, pp } = setup();
    const b = await beginCheckout(deps, p.id);
    const orderId = b.ok ? b.pact.order_id! : "";
    const early = await completeCheckout(deps, p.id, orderId);
    expect(early.ok).toBe(false);
    expect(!early.ok && early.code).toBe("not_approved");
    pp.approveOrder(orderId);
    const done = await completeCheckout(deps, p.id, orderId);
    expect(done.ok && done.pact.status).toBe("HELD");
    expect(authorizationForPact(db, p.id)!.status).toBe("CREATED");
    expect(done.ok && done.pact.authorized_cents).toBe(300);
    // idempotent second completion
    const again = await completeCheckout(deps, p.id, orderId);
    expect(again.ok && again.pact.status).toBe("HELD");
    expect(pp.auths.size).toBe(1);
  });

  test("order id that belongs to another pact is rejected without any PayPal call", async () => {
    const { deps, p, pp } = setup();
    await beginCheckout(deps, p.id);
    const calls = pp.calls.length;
    const r = await completeCheckout(deps, p.id, "O999999");
    expect(!r.ok && r.code).toBe("ownership");
    expect(pp.calls.length).toBe(calls);
  });

  test("amount tampering on the order is detected", async () => {
    const { deps, p, pp } = setup();
    const b = await beginCheckout(deps, p.id);
    const orderId = b.ok ? b.pact.order_id! : "";
    pp.orders.get(orderId)!.purchase_units[0]!.amount.value = "1.00";
    pp.approveOrder(orderId);
    const r = await completeCheckout(deps, p.id, orderId);
    expect(!r.ok && r.code).toBe("mismatch");
  });

  test("expiry releases the reservation and rejects a late approval", async () => {
    const { db, deps, p, m, pp } = setup();
    const b = await beginCheckout(deps, p.id, 1); // 1 ms deadline
    const orderId = b.ok ? b.pact.order_id! : "";
    await Bun.sleep(5);
    const expired = await expireCheckouts(deps);
    expect(expired).toEqual([p.id]);
    expect(getMandate(db, m.id)!.reserved_cents).toBe(0);
    pp.approveOrder(orderId);
    const late = await completeCheckout(deps, p.id, orderId);
    expect(!late.ok && late.code).toBe("state");
    expect(pp.auths.size).toBe(0);
  });

  test("authorize timeout -> unknown keeps reservation; retry replays; sweeper does not expire it", async () => {
    const { db, deps, p, m, pp } = setup();
    const b = await beginCheckout(deps, p.id, 1);
    const orderId = b.ok ? b.pact.order_id! : "";
    pp.approveOrder(orderId);
    pp.fault("authorizeOrder", { kind: "timeout_after_success" });
    const r1 = await completeCheckout(deps, p.id, orderId);
    expect(!r1.ok && r1.code).toBe("unknown");
    expect(getMandate(db, m.id)!.reserved_cents).toBe(300);
    await Bun.sleep(5);
    // Sweeper reconciles from the order and finds the authorization instead of expiring.
    const expired = await expireCheckouts(deps);
    expect(expired).toEqual([]);
    const pact = (await completeCheckout(deps, p.id, orderId));
    expect(pact.ok && pact.pact.status).toBe("HELD");
    expect(pp.auths.size).toBe(1);
  });

  test("a checkout-held pact settles through the existing flow", async () => {
    const { db, deps, p, pp } = setup();
    const b = await beginCheckout(deps, p.id);
    const orderId = b.ok ? b.pact.order_id! : "";
    pp.approveOrder(orderId);
    await completeCheckout(deps, p.id, orderId);
    transition(db, p.id, "DELIVERED");
    transition(db, p.id, "VERIFIED");
    const s = await settlePact(deps, p.id, [{ sku: "SKU-1", verdict: "accepted", reason: "", score: null, evidence: [] }]);
    expect(s!.status).toBe("SETTLED");
    expect(s!.settlement_kind).toBe("partial");
    expect(s!.charge_cents).toBe(100);
  });
});
