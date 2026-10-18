/**
 * Payment vertical slice against the real sandbox, no LLM involved:
 * mandate -> pact -> offer/accept -> hold -> (scripted verdicts) -> settle -> payout.
 *
 *   bun scripts/slice.ts full      # all 3 items accepted: full capture + payout
 *   bun scripts/slice.ts partial   # 1 of 3 accepted: partial final capture + payout
 *   bun scripts/slice.ts void      # none accepted: void, nothing charged
 *
 * Uses a throwaway DB in runs/ so it never touches the app database.
 */
import { loadConfig } from "../src/config";
import { listEvents, openDb } from "../src/db";
import { createMandate, getMandate } from "../src/mandate";
import { createPact, pactHash, transition } from "../src/pact/machine";
import type { ItemVerdict } from "../src/pact/types";
import { PayPalClient } from "../src/paypal/client";
import { confirmCapture, confirmPayout, holdPact, payoutPact, settlePact, type FlowDeps } from "../src/payments/flow";
import { authorizationForPact, captureForPact, payoutForPact } from "../src/payments/resources";

const scenario = (process.argv[2] ?? "full") as "full" | "partial" | "void";
const config = loadConfig();
if (!config.clientId || !config.clientSecret || !config.sellerEmail) {
  console.error("PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and SELLER_SANDBOX_EMAIL must be set");
  process.exit(2);
}

const db = openDb(`runs/slice-${Date.now()}.db`);
const paypal = new PayPalClient({ base: config.paypalBase, clientId: config.clientId, clientSecret: config.clientSecret });
const deps: FlowDeps = {
  db,
  paypal,
  sellerEmail: config.sellerEmail,
  buyerCard: {
    number: "4012888888881881",
    expiry: "2030-12",
    name: "Buyer Agent",
    security_code: "123",
    billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
  },
};

const job = {
  id: `slice-${scenario}`,
  category: "product_descriptions" as const,
  title: "3 product descriptions",
  brief: "slice run",
  skus: [1, 2, 3].map((i) => ({ sku: `SKU-${i}`, facts: { name: `Widget ${i}` } })),
  rubric: { criteria: ["factual"], threshold: 0.7, minWords: 10, maxWords: 80 },
  maxUnitPriceCents: 200,
  seller: config.sellerEmail,
};
const offer = { unitPriceCents: 100, etaMinutes: 1, note: "slice" };
const verdictsFor: Record<string, ItemVerdict[]> = {
  full: ["SKU-1", "SKU-2", "SKU-3"].map((sku) => ({ sku, verdict: "accepted", reason: "ok", score: 1, evidence: [] })),
  partial: [{ sku: "SKU-1", verdict: "accepted", reason: "ok", score: 1, evidence: [] }, { sku: "SKU-2", verdict: "rejected", reason: "fault injected", score: 0.2, evidence: [] }],
  void: [],
};

const m = createMandate(db, { maxPerPactCents: 1000, maxAggregateCents: 5000, allowedCategory: "product_descriptions", allowedSeller: config.sellerEmail });
const p = createPact(db, m.id, job);
transition(db, p.id, "OFFERED", { offer_json: JSON.stringify(offer), unit_price_cents: offer.unitPriceCents });
transition(db, p.id, "AGREED", { pact_hash: await pactHash(job, offer) });

const t0 = Date.now();
const held = await holdPact(deps, p.id);
console.log(`hold      ${held!.status}  auth=${authorizationForPact(db, p.id)?.id} status=${authorizationForPact(db, p.id)?.status} amount=${held!.authorized_cents}c`);
if (held!.status !== "HELD") process.exit(1);

transition(db, p.id, "DELIVERED");
transition(db, p.id, "VERIFIED");
let s = await settlePact(deps, p.id, verdictsFor[scenario]!);
for (let i = 0; i < 10 && s!.status === "SETTLING"; i++) {
  await Bun.sleep(3000);
  s = await confirmCapture(deps, p.id);
}
const cap = captureForPact(db, p.id);
console.log(`settle    ${s!.status}  kind=${s!.settlement_kind} charge=${s!.charge_cents}c capture=${cap?.id ?? "-"} capStatus=${cap?.status ?? "-"} auth=${authorizationForPact(db, p.id)?.status}`);
if (s!.status !== "SETTLED") process.exit(1);

if (s!.settlement_kind !== "void") {
  let po = await payoutPact(deps, p.id);
  for (let i = 0; i < 12 && po!.status === "SETTLED"; i++) {
    await Bun.sleep(5000);
    po = await confirmPayout(deps, p.id);
  }
  const item = payoutForPact(db, p.id);
  console.log(`payout    ${po!.status}  item=${item?.item_id} status=${item?.status} amount=${item?.amount_cents}c -> ${item?.receiver}`);
  if (po!.status !== "PAID_OUT") process.exit(1);
}

const mm = getMandate(db, m.id)!;
console.log(`mandate   reserved=${mm.reserved_cents}c spent=${mm.spent_cents}c`);
console.log(`events    ${listEvents(db, p.id).map((e) => e.type).join(" > ")}`);
console.log(`elapsed   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
