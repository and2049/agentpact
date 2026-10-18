/**
 * Thin typed PayPal REST client for the calls the design depends on.
 * Every mutating call takes an explicit requestId (PayPal-Request-Id) so a retry
 * after a timeout replays the same request instead of creating a second one.
 */
import { centsToAmount } from "../money";

export interface Amount {
  currency_code: string;
  value: string;
}

export interface Authorization {
  id: string;
  status: string;
  amount: Amount;
  expiration_time?: string;
  custom_id?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
}

export interface Capture {
  id: string;
  status: string;
  amount: Amount;
  final_capture?: boolean;
  custom_id?: string;
  seller_receivable_breakdown?: { paypal_fee?: Amount; net_amount?: Amount };
}

export interface Order {
  id: string;
  status: string;
  intent: string;
  purchase_units: Array<{
    reference_id?: string;
    custom_id?: string;
    amount: Amount;
    payments?: { authorizations?: Authorization[]; captures?: Capture[] };
  }>;
}

export interface PayoutItem {
  payout_item_id: string;
  transaction_status: string;
  payout_batch_id: string;
  payout_item: { receiver: string; amount: { currency: string; value: string }; sender_item_id?: string };
}

export interface PayoutBatch {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header: { sender_batch_id: string } };
  items?: PayoutItem[];
}

export interface CardSource {
  number: string;
  expiry: string;
  name: string;
  security_code?: string;
  billing_address?: Record<string, string>;
}

/** The subset of PayPal the app calls. Tests substitute a fake. */
export interface PayPalApi {
  createCardAuthorizedOrder(args: {
    requestId: string;
    amountCents: number;
    customId: string;
    referenceId: string;
    card: CardSource;
  }): Promise<Order>;
  getAuthorization(id: string): Promise<Authorization>;
  captureAuthorization(args: { requestId: string; authorizationId: string; amountCents: number; final: boolean }): Promise<Capture>;
  voidAuthorization(args: { requestId: string; authorizationId: string }): Promise<Authorization>;
  getCapture(id: string): Promise<Capture>;
  createPayout(args: {
    requestId: string;
    senderBatchId: string;
    senderItemId: string;
    receiverEmail: string;
    amountCents: number;
    note: string;
  }): Promise<PayoutBatch>;
  getPayout(batchId: string): Promise<PayoutBatch>;
  verifyWebhookSignature(args: { webhookId: string; headers: Record<string, string>; body: string }): Promise<boolean>;
}

/** HTTP-level failure with a response from PayPal (outcome is known: it failed). */
export class PayPalHttpError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message?: string,
  ) {
    super(message ?? `PayPal HTTP ${status}`);
  }
}

/** Transport failure: timeout or network error. The outcome is UNKNOWN. */
export class PayPalTransportError extends Error {}

export interface ClientOptions {
  base: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class PayPalClient implements PayPalApi {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.opts.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${this.opts.clientId}:${this.opts.clientSecret}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) throw new PayPalHttpError(res.status, json, `token: ${json.error_description ?? res.status}`);
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async request<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new PayPalTransportError(`${method} ${path}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new PayPalHttpError(res.status, json, `${method} ${path} -> ${res.status}`);
    return json as T;
  }

  createCardAuthorizedOrder(args: {
    requestId: string;
    amountCents: number;
    customId: string;
    referenceId: string;
    card: CardSource;
  }): Promise<Order> {
    return this.request<Order>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: args.referenceId,
            custom_id: args.customId,
            amount: { currency_code: "USD", value: centsToAmount(args.amountCents) },
          },
        ],
        payment_source: { card: args.card },
      },
      args.requestId,
    );
  }

  getAuthorization(id: string): Promise<Authorization> {
    return this.request<Authorization>("GET", `/v2/payments/authorizations/${id}`);
  }

  captureAuthorization(args: { requestId: string; authorizationId: string; amountCents: number; final: boolean }): Promise<Capture> {
    return this.request<Capture>(
      "POST",
      `/v2/payments/authorizations/${args.authorizationId}/capture`,
      { amount: { currency_code: "USD", value: centsToAmount(args.amountCents) }, final_capture: args.final },
      args.requestId,
    );
  }

  voidAuthorization(args: { requestId: string; authorizationId: string }): Promise<Authorization> {
    return this.request<Authorization>("POST", `/v2/payments/authorizations/${args.authorizationId}/void`, {}, args.requestId);
  }

  getCapture(id: string): Promise<Capture> {
    return this.request<Capture>("GET", `/v2/payments/captures/${id}`);
  }

  createPayout(args: {
    requestId: string;
    senderBatchId: string;
    senderItemId: string;
    receiverEmail: string;
    amountCents: number;
    note: string;
  }): Promise<PayoutBatch> {
    return this.request<PayoutBatch>(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: { sender_batch_id: args.senderBatchId, email_subject: "AgentPact payment for accepted work" },
        items: [
          {
            recipient_type: "EMAIL",
            receiver: args.receiverEmail,
            amount: { currency: "USD", value: centsToAmount(args.amountCents) },
            note: args.note,
            sender_item_id: args.senderItemId,
          },
        ],
      },
      args.requestId,
    );
  }

  getPayout(batchId: string): Promise<PayoutBatch> {
    return this.request<PayoutBatch>("GET", `/v1/payments/payouts/${batchId}`);
  }

  async verifyWebhookSignature(args: { webhookId: string; headers: Record<string, string>; body: string }): Promise<boolean> {
    const h = (k: string) => args.headers[k] ?? args.headers[k.toLowerCase()] ?? "";
    const res = await this.request<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: args.webhookId,
      webhook_event: JSON.parse(args.body),
    });
    return res.verification_status === "SUCCESS";
  }
}
