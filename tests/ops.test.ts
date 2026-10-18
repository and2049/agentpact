import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { getOp, runOp } from "../src/payments/ops";
import { FakePayPal } from "./fake-paypal";

describe("payment ops log", () => {
  test("writes row before call, succeeded after", async () => {
    const db = openDb();
    const pp = new FakePayPal();
    let seenRow = false;
    const r = await runOp({
      db,
      pactId: "p",
      kind: "void",
      opId: "p:void",
      call: async (requestId) => {
        seenRow = getOp(db, "p:void")?.status === "pending" && getOp(db, "p:void")?.request_id === requestId;
        const o = await pp.createCardAuthorizedOrder({ requestId, amountCents: 100, customId: "p", referenceId: "p", card: {} as never });
        return o;
      },
      resourceIdOf: (o) => o.id,
    });
    expect(seenRow).toBe(true);
    expect(r.status).toBe("succeeded");
    expect(getOp(db, "p:void")?.status).toBe("succeeded");
  });

  test("timeout-after-success -> unknown; retry reuses request id and replays the same resource", async () => {
    const db = openDb();
    const pp = new FakePayPal();
    pp.fault("createCardAuthorizedOrder", { kind: "timeout_after_success" });
    const spec = {
      db,
      pactId: "p",
      kind: "hold",
      opId: "p:hold",
      call: (requestId: string) => pp.createCardAuthorizedOrder({ requestId, amountCents: 100, customId: "p", referenceId: "p", card: {} as never }),
      resourceIdOf: (o: { id: string }) => o.id,
    };
    const r1 = await runOp(spec);
    expect(r1.status).toBe("unknown");
    const rid1 = getOp(db, "p:hold")!.request_id;
    const r2 = await runOp(spec);
    expect(r2.status).toBe("succeeded");
    expect(getOp(db, "p:hold")!.request_id).toBe(rid1);
    expect(getOp(db, "p:hold")!.attempts).toBe(2);
    // the fake created exactly one order
    expect(pp.auths.size).toBe(1);
    // a third call replays from the log without hitting PayPal
    const before = pp.calls.length;
    const r3 = await runOp(spec);
    expect(r3.status).toBe("succeeded");
    expect(r3.status === "succeeded" && r3.replayed).toBe(true);
    expect(pp.calls.length).toBe(before);
  });

  test("http error -> failed with body", async () => {
    const db = openDb();
    const pp = new FakePayPal();
    pp.fault("voidAuthorization", { kind: "http", status: 422, body: { name: "UNPROCESSABLE_ENTITY" } });
    const r = await runOp({
      db,
      pactId: "p",
      kind: "void",
      opId: "p:void",
      call: (requestId) => pp.voidAuthorization({ requestId, authorizationId: "nope" }),
      resourceIdOf: (a) => a.id,
    });
    expect(r.status).toBe("failed");
    expect(getOp(db, "p:void")?.status).toBe("failed");
    expect(getOp(db, "p:void")?.response_json).toContain("UNPROCESSABLE");
  });
});
