import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createMandate, getMandate, reserve } from "../src/mandate";
import { createPact, getPact, transition } from "../src/pact/machine";
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
    expect(pact!.authorized_cents).toBeNull(); // approval is not a hold
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
    expect(expired.expired).toEqual([p.id]);
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
    // Sweeper reconciles from the order, finds the authorization and promotes the pact instead of expiring it.
    const swept = await expireCheckouts(deps);
    expect(swept.expired).toEqual([]);
    expect(swept.held).toEqual([p.id]);
    expect(getMandate(db, m.id)!.reserved_cents).toBe(300);
    const pact = (await completeCheckout(deps, p.id, orderId)); // idempotent on HELD
    expect(pact.ok && pact.pact.status).toBe("HELD");
    expect(pp.auths.size).toBe(1);
  });

  test("sweeper: an authorize op still in flight keeps the reservation; a recorded CREATED authorization is promoted to HELD", async () => {
    const { db, deps, p, m, pp } = setup();
    const b = await beginCheckout(deps, p.id, 1);
    const orderId = b.ok ? b.pact.order_id! : "";
    await Bun.sleep(5);
    // Simulate the approve route mid-call: the op row exists and is pending.
    db.run("INSERT INTO payment_ops (op_id, pact_id, kind, request_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'authorize_order', 'r1', 'pending', 1, ?, ?)", [`${p.id}:authorize`, p.id, new Date().toISOString(), new Date().toISOString()]);
    let r = await expireCheckouts(deps);
    expect(r).toEqual({ expired: [], held: [] });
    expect(getMandate(db, m.id)!.reserved_cents).toBe(300);
    // The authorization got recorded (e.g. by a webhook) but the pact never transitioned.
    pp.approveOrder(orderId);
    const order = await pp.authorizeOrder({ requestId: "r1", orderId });
    db.run("UPDATE payment_ops SET status = 'succeeded' WHERE op_id = ?", [`${p.id}:authorize`]);
    const { recordAuthorization } = await import("../src/payments/resources");
    recordAuthorization(db, p.id, orderId, order.purchase_units[0]!.payments!.authorizations![0]!);
    r = await expireCheckouts(deps);
    expect(r.held).toEqual([p.id]);
    const held = (await import("../src/pact/machine")).getPact(db, p.id)!;
    expect(held.status).toBe("HELD");
    expect(held.authorized_cents).toBe(300);
  });

  test("sweeper runs each pact under the caller's lock", async () => {
    const { db, deps, p } = setup();
    await beginCheckout(deps, p.id, 1);
    await Bun.sleep(5);
    const seen: string[] = [];
    const r = await expireCheckouts(deps, { lock: async (id, fn) => { seen.push(id); return fn(); } });
    expect(seen).toEqual([p.id]);
    expect(r.expired).toEqual([p.id]);
    expect(db.query<{ status: string }, [string]>("SELECT status FROM pacts WHERE id = ?").get(p.id)!.status).toBe("CHECKOUT_EXPIRED");
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

  test("an authorize op orphaned as pending by a crash is resumed by the sweeper with the same request id", async () => {
    const { db, deps, p, m, pp } = setup();
    const b = await beginCheckout(deps, p.id);
    const orderId = b.ok ? b.pact.order_id! : "";
    pp.approveOrder(orderId);
    // The HTTP call happened (PayPal holds the money) but the process died before the op row was updated.
    const order = await pp.authorizeOrder({ requestId: "crash-req", orderId });
    expect(order.purchase_units[0]!.payments!.authorizations![0]!.status).toBe("CREATED");
    db.run("INSERT INTO payment_ops (op_id, pact_id, kind, request_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'authorize_order', 'crash-req', 'pending', 1, '2026-01-01', '2026-01-01')", [`${p.id}:authorize`, p.id]);
    const held: string[] = [];
    const r = await expireCheckouts(deps, { onHeld: (id) => held.push(id) });
    expect(r.held).toEqual([p.id]);
    expect(held).toEqual([p.id]);
    expect(getPact(db, p.id)!.status).toBe("HELD");
    expect(pp.auths.size).toBe(1); // replayed request id, no second hold
    expect(getMandate(db, m.id)!.reserved_cents).toBe(300);
    // a *recent* pending op is left alone
    const { db: db2, deps: deps2, p: p2 } = setup();
    const b2 = await beginCheckout(deps2, p2.id);
    db2.run("INSERT INTO payment_ops (op_id, pact_id, kind, request_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'authorize_order', 'live', 'pending', 1, ?, ?)", [`${p2.id}:authorize`, p2.id, new Date().toISOString(), new Date().toISOString()]);
    expect(await expireCheckouts(deps2)).toEqual({ expired: [], held: [] });
    expect(b2.ok).toBe(true);
  });

  test("a market pact whose order was never created expires one TTL after its last update", async () => {
    const { db, deps, p, m } = setup();
    reserve(db, { mandateId: m.id, pactId: p.id, amountCents: 300, category: "product_descriptions", seller: SELLER });
    db.run("UPDATE pacts SET kind = 'market', updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [p.id]);
    const r = await expireCheckouts(deps);
    expect(r.expired).toEqual([p.id]);
    expect(getMandate(db, m.id)!.reserved_cents).toBe(0);
  });

  test("sweeper decisions use the pact as read inside the lock (an order created meanwhile is not expired)", async () => {
    const { db, deps, p, m } = setup();
    reserve(db, { mandateId: m.id, pactId: p.id, amountCents: 300, category: "product_descriptions", seller: SELLER });
    db.run("UPDATE pacts SET kind = 'market', updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [p.id]);
    // The lock is acquired after beginCheckout ran (simulating the approve/award route winning the lock first).
    const r = await expireCheckouts(deps, { lock: async (_id, fn) => { await beginCheckout(deps, p.id); return fn(); } });
    expect(r.expired).toEqual([]);
    expect(getPact(db, p.id)!.status).toBe("AGREED");
    expect(getPact(db, p.id)!.order_id).toMatch(/^O/);
    expect(getMandate(db, m.id)!.reserved_cents).toBe(300);
  });

  test("an orphaned authorize op whose replay is denied closes the pact and reports it", async () => {
    const { db, deps, p, m, pp } = setup();
    const b = await beginCheckout(deps, p.id);
    const orderId = b.ok ? b.pact.order_id! : "";
    pp.approveOrder(orderId);
    db.run("INSERT INTO payment_ops (op_id, pact_id, kind, request_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'authorize_order', 'crash-req', 'pending', 1, '2026-01-01', '2026-01-01')", [`${p.id}:authorize`, p.id]);
    pp.fault("authorizeOrder", { kind: "http", status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYER_CANNOT_PAY" }] } });
    const closed: string[] = [];
    const r = await expireCheckouts(deps, { onClosed: (id) => closed.push(id) });
    expect(r).toEqual({ expired: [], held: [] });
    expect(closed).toEqual([p.id]);
    expect(getPact(db, p.id)!.status).toBe("HOLD_FAILED");
    expect(getMandate(db, m.id)!.reserved_cents).toBe(0);
  });
});
