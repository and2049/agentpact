/**
 * Day-1 integration gate. Proves, against the PayPal sandbox, every payment
 * operation the design depends on. Run: `bun scripts/gate.ts`.
 *
 * Steps (DESIGN.md §7, Oct 18):
 *   a. card order with intent AUTHORIZE -> authorization
 *   b. full capture to COMPLETED
 *   c. partial final capture on a second authorization
 *   d. void on a third authorization
 *   e. one payout to the seller sandbox account, tracked to item SUCCESS
 *
 * Each step prints PASS/FAIL. Raw request/response JSON is written to
 * runs/gate-<timestamp>.json (gitignored). Nothing here is reused by the app;
 * it exists to answer the feasibility question before any real code is written.
 */

const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ?? "";
const SELLER_EMAIL = process.env.SELLER_SANDBOX_EMAIL ?? "";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env");
  process.exit(2);
}

type Log = { step: string; request?: unknown; response?: unknown; status?: number };
const log: Log[] = [];
const results: Array<{ step: string; ok: boolean; note: string }> = [];

function record(step: string, ok: boolean, note: string) {
  results.push({ step, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}  ${note}`);
}

async function token(): Promise<string> {
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = (await res.json()) as { access_token?: string; error_description?: string };
  log.push({ step: "token", status: res.status, response: { ...json, access_token: json.access_token ? "<redacted>" : undefined } });
  if (!res.ok || !json.access_token) throw new Error(`token failed: ${res.status} ${json.error_description ?? ""}`);
  return json.access_token;
}

let TOKEN = "";

async function pp<T = any>(step: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": crypto.randomUUID(),
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  log.push({ step, request: body, status: res.status, response: json });
  return { status: res.status, json };
}

// Sandbox test card from https://developer.paypal.com/tools/sandbox/card-testing/
const TEST_CARD = {
  number: "4012888888881881",
  expiry: "2030-12",
  name: "Buyer Agent",
  security_code: "123",
  billing_address: {
    address_line_1: "1 Main St",
    admin_area_2: "San Jose",
    admin_area_1: "CA",
    postal_code: "95131",
    country_code: "US",
  },
};

/** Create an AUTHORIZE-intent card order and return the authorization id. */
async function createAuthorizedOrder(label: string, amount: string): Promise<string | null> {
  const create = await pp(`${label}:create-order`, "POST", "/v2/checkout/orders", {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: label,
        custom_id: `gate-${label}`,
        amount: { currency_code: "USD", value: amount },
      },
    ],
    payment_source: { card: TEST_CARD },
  });
  if (create.status >= 300) {
    record(`${label} create order`, false, `${create.status} ${JSON.stringify(create.json?.details ?? create.json).slice(0, 300)}`);
    return null;
  }
  const orderId: string = create.json.id;
  let auth = create.json.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) {
    // Card orders usually authorize inline; if not, call /authorize explicitly.
    const authorize = await pp(`${label}:authorize`, "POST", `/v2/checkout/orders/${orderId}/authorize`, {});
    if (authorize.status >= 300) {
      record(`${label} authorize`, false, `order ${orderId} status=${create.json.status}; /authorize -> ${authorize.status} ${JSON.stringify(authorize.json?.details ?? authorize.json).slice(0, 300)}`);
      return null;
    }
    auth = authorize.json.purchase_units?.[0]?.payments?.authorizations?.[0];
  }
  if (!auth?.id) {
    record(`${label} authorization`, false, `order ${orderId} status=${create.json.status}, no authorization in response`);
    return null;
  }
  record(`${label} authorization`, true, `order ${orderId} auth ${auth.id} status=${auth.status} amount=${auth.amount?.value}`);
  return auth.id;
}

async function main() {
  TOKEN = await token();
  record("token", true, "client credentials OK");

  // (a) + (b): authorize 20.00 then capture in full.
  const authA = await createAuthorizedOrder("A", "20.00");
  if (authA) {
    const cap = await pp("A:capture-full", "POST", `/v2/payments/authorizations/${authA}/capture`, {
      amount: { currency_code: "USD", value: "20.00" },
      final_capture: true,
    });
    const ok = cap.status < 300 && cap.json?.status === "COMPLETED";
    record("b full capture", ok, `${cap.status} capture ${cap.json?.id ?? "?"} status=${cap.json?.status ?? JSON.stringify(cap.json?.details ?? cap.json).slice(0, 200)}`);
  }

  // (c): authorize 20.00, capture 13.00 final (releases the remainder).
  const authB = await createAuthorizedOrder("B", "20.00");
  if (authB) {
    const cap = await pp("B:capture-partial", "POST", `/v2/payments/authorizations/${authB}/capture`, {
      amount: { currency_code: "USD", value: "13.00" },
      final_capture: true,
    });
    const ok = cap.status < 300 && (cap.json?.status === "COMPLETED" || cap.json?.status === "PENDING");
    record("c partial final capture", ok, `${cap.status} capture ${cap.json?.id ?? "?"} status=${cap.json?.status ?? JSON.stringify(cap.json?.details ?? cap.json).slice(0, 200)}`);
    const after = await pp("B:get-auth", "GET", `/v2/payments/authorizations/${authB}`);
    record("c authorization after partial", after.json?.status === "CAPTURED" || after.json?.status === "PARTIALLY_CAPTURED", `auth status=${after.json?.status}`);
  }

  // (d): authorize 20.00 then void.
  const authC = await createAuthorizedOrder("C", "20.00");
  if (authC) {
    const v = await pp("C:void", "POST", `/v2/payments/authorizations/${authC}/void`, {});
    const after = await pp("C:get-auth", "GET", `/v2/payments/authorizations/${authC}`);
    const ok = v.status < 300 && after.json?.status === "VOIDED";
    record("d void", ok, `void -> ${v.status}; auth status=${after.json?.status}`);
  }

  // (e): payout 1.00 to the seller sandbox account, poll to item status.
  if (!SELLER_EMAIL) {
    record("e payout", false, "SELLER_SANDBOX_EMAIL not set; create a personal sandbox account first");
  } else {
    const batchId = `gate-${Date.now()}`;
    const po = await pp("E:payout", "POST", "/v1/payments/payouts", {
      sender_batch_header: { sender_batch_id: batchId, email_subject: "AgentPact gate payout" },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: SELLER_EMAIL,
          amount: { currency: "USD", value: "1.00" },
          note: "day-1 gate",
          sender_item_id: `${batchId}-1`,
        },
      ],
    });
    if (po.status >= 300) {
      record("e payout", false, `${po.status} ${JSON.stringify(po.json?.details ?? po.json).slice(0, 300)}`);
    } else {
      const payoutBatchId: string = po.json.batch_header.payout_batch_id;
      let itemStatus = "?";
      let batchStatus = "?";
      for (let i = 0; i < 12; i++) {
        await Bun.sleep(5000);
        const g = await pp(`E:poll-${i}`, "GET", `/v1/payments/payouts/${payoutBatchId}`);
        batchStatus = g.json?.batch_header?.batch_status ?? "?";
        itemStatus = g.json?.items?.[0]?.transaction_status ?? "?";
        if (["SUCCESS", "FAILED", "UNCLAIMED", "BLOCKED", "RETURNED"].includes(itemStatus)) break;
      }
      record("e payout item", itemStatus === "SUCCESS", `batch ${payoutBatchId} batch_status=${batchStatus} item=${itemStatus}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `runs/gate-${stamp}.json`;
  await Bun.write(out, JSON.stringify({ results, log }, null, 2));
  console.log(`\nraw log: ${out}`);
  const core = results.filter((r) => /authorization|full capture|partial|void/.test(r.step));
  const coreOk = core.length >= 5 && core.every((r) => r.ok);
  console.log(coreOk ? "\nGATE (a)-(d): PASS" : "\nGATE (a)-(d): FAIL -> see DESIGN.md §7 fallback (browser approval), then re-plan if that fails too");
  process.exit(coreOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
