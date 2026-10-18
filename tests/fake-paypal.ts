/** In-memory PayPal fake with request-id idempotency and fault injection. */
import type { Authorization, Capture, CardSource, Order, PayoutBatch, PayPalApi } from "../src/paypal/client";
import { PayPalHttpError, PayPalTransportError } from "../src/paypal/client";
import { centsToAmount } from "../src/money";

type Fault = { kind: "http"; status: number; body?: unknown } | { kind: "timeout_after_success" } | { kind: "timeout_before" };

export class FakePayPal implements PayPalApi {
  auths = new Map<string, Authorization & { orderId: string }>();
  captures = new Map<string, Capture & { authId: string }>();
  payouts = new Map<string, PayoutBatch>();
  byRequestId = new Map<string, unknown>();
  faults = new Map<string, Fault[]>(); // keyed by method name
  calls: string[] = [];
  /** Capture status to return on create; tests set "PENDING" to simulate pending captures. */
  captureStatus = "COMPLETED";
  payoutItemStatus = "SUCCESS";
  private n = 0;

  fault(method: string, f: Fault) {
    this.faults.set(method, [...(this.faults.get(method) ?? []), f]);
  }

  private id(prefix: string) {
    return `${prefix}${(++this.n).toString().padStart(6, "0")}`;
  }

  private async guarded<T>(method: string, requestId: string | undefined, produce: () => T): Promise<T> {
    this.calls.push(method);
    if (requestId && this.byRequestId.has(requestId)) return this.byRequestId.get(requestId) as T;
    const f = this.faults.get(method)?.shift();
    if (f?.kind === "http") throw new PayPalHttpError(f.status, f.body ?? { name: "FAKE" });
    if (f?.kind === "timeout_before") throw new PayPalTransportError("timeout");
    const result = produce();
    if (requestId) this.byRequestId.set(requestId, result);
    if (f?.kind === "timeout_after_success") throw new PayPalTransportError("timeout after success");
    return result;
  }

  createCardAuthorizedOrder(args: { requestId: string; amountCents: number; customId: string; referenceId: string; card: CardSource }): Promise<Order> {
    return this.guarded("createCardAuthorizedOrder", args.requestId, () => {
      const orderId = this.id("O");
      const auth: Authorization & { orderId: string } = {
        id: this.id("A"),
        status: "CREATED",
        amount: { currency_code: "USD", value: centsToAmount(args.amountCents) },
        expiration_time: new Date(Date.now() + 29 * 864e5).toISOString(),
        custom_id: args.customId,
        orderId,
      };
      this.auths.set(auth.id, auth);
      return {
        id: orderId,
        status: "COMPLETED",
        intent: "AUTHORIZE",
        purchase_units: [{ reference_id: args.referenceId, custom_id: args.customId, amount: auth.amount, payments: { authorizations: [auth] } }],
      };
    });
  }

  getAuthorization(id: string): Promise<Authorization> {
    return this.guarded("getAuthorization", undefined, () => {
      const a = this.auths.get(id);
      if (!a) throw new PayPalHttpError(404, { name: "RESOURCE_NOT_FOUND" });
      return { ...a };
    });
  }

  captureAuthorization(args: { requestId: string; authorizationId: string; amountCents: number; final: boolean }): Promise<Capture> {
    return this.guarded("captureAuthorization", args.requestId, () => {
      const a = this.auths.get(args.authorizationId);
      if (!a) throw new PayPalHttpError(404, { name: "RESOURCE_NOT_FOUND" });
      if (a.status !== "CREATED") throw new PayPalHttpError(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED" }] });
      const cap: Capture & { authId: string } = {
        id: this.id("C"),
        status: this.captureStatus,
        amount: { currency_code: "USD", value: centsToAmount(args.amountCents) },
        final_capture: args.final,
        authId: a.id,
      };
      this.captures.set(cap.id, cap);
      a.status = "CAPTURED";
      return { ...cap };
    });
  }

  voidAuthorization(args: { requestId: string; authorizationId: string }): Promise<Authorization> {
    return this.guarded("voidAuthorization", args.requestId, () => {
      const a = this.auths.get(args.authorizationId);
      if (!a) throw new PayPalHttpError(404, { name: "RESOURCE_NOT_FOUND" });
      a.status = "VOIDED";
      return { ...a };
    });
  }

  getCapture(id: string): Promise<Capture> {
    return this.guarded("getCapture", undefined, () => {
      const c = this.captures.get(id);
      if (!c) throw new PayPalHttpError(404, { name: "RESOURCE_NOT_FOUND" });
      return { ...c };
    });
  }

  /** Test helper: flip a pending capture to a terminal status. */
  completeCapture(id: string, status = "COMPLETED") {
    const c = this.captures.get(id);
    if (c) c.status = status;
  }

  createPayout(args: { requestId: string; senderBatchId: string; senderItemId: string; receiverEmail: string; amountCents: number }): Promise<PayoutBatch> {
    return this.guarded("createPayout", args.requestId, () => {
      const batchId = this.id("P");
      const batch: PayoutBatch = {
        batch_header: { payout_batch_id: batchId, batch_status: "PENDING", sender_batch_header: { sender_batch_id: args.senderBatchId } },
        items: [
          {
            payout_item_id: this.id("I"),
            transaction_status: this.payoutItemStatus,
            payout_batch_id: batchId,
            payout_item: { receiver: args.receiverEmail, amount: { currency: "USD", value: centsToAmount(args.amountCents) }, sender_item_id: args.senderItemId },
          },
        ],
      };
      this.payouts.set(batchId, batch);
      return batch;
    });
  }

  getPayout(batchId: string): Promise<PayoutBatch> {
    return this.guarded("getPayout", undefined, () => {
      const b = this.payouts.get(batchId);
      if (!b) throw new PayPalHttpError(404, { name: "RESOURCE_NOT_FOUND" });
      return b;
    });
  }

  setPayoutItemStatus(batchId: string, status: string) {
    const b = this.payouts.get(batchId);
    if (b?.items?.[0]) b.items[0].transaction_status = status;
  }

  async verifyWebhookSignature(): Promise<boolean> {
    return true;
  }
}
