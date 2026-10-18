/**
 * Full vertical slice against the real sandbox and the real LLM:
 *   bun scripts/run.ts [good|partial|broken]
 * Uses a throwaway DB under runs/ and prints the transcript as it happens.
 */
import { realAgents } from "../src/agents";
import { loadConfig } from "../src/config";
import { listEvents, openDb } from "../src/db";
import { sampleJob } from "../src/jobs/sample";
import { loadLlmConfig } from "../src/llm";
import { createMandate } from "../src/mandate";
import { runPact } from "../src/pact/run";
import { PayPalClient } from "../src/paypal/client";
import type { Scenario } from "../src/faults";

const scenario = (process.argv[2] ?? "good") as Scenario;
const config = loadConfig();
const db = openDb(`runs/run-${scenario}-${Date.now()}.db`);
const paypal = new PayPalClient({ base: config.paypalBase, clientId: config.clientId, clientSecret: config.clientSecret });
const { agents, describe } = realAgents(loadLlmConfig(), `run-${Date.now()}`);
console.log(`llm       ${describe}\nscenario  ${scenario}`);

const mandate = createMandate(db, { maxPerPactCents: 5000, maxAggregateCents: 20000, allowedCategory: "product_descriptions", allowedSeller: config.sellerEmail });
const job = sampleJob(config.sellerEmail);

// Tail events while the run is in progress.
let last = 0;
let pactId: string | null = null;
const tail = setInterval(() => {
  if (!pactId) {
    const row = db.query<{ id: string }, []>("SELECT id FROM pacts ORDER BY created_at DESC LIMIT 1").get();
    if (!row) return;
    pactId = row.id;
  }
  for (const e of listEvents(db, pactId, last)) {
    last = e.seq;
    const p = JSON.parse(e.payload_json);
    if (e.type === "agent.message") console.log(`  [${p.role}] ${p.text}`);
    else if (e.type === "verifier.item") console.log(`    ${p.sku} ${p.verdict} ${p.score === null ? "" : p.score.toFixed(2)} ${p.reason}`);
    else if (e.type === "seller.progress") console.log(`    seller: ${p.skus.join(",")}`);
    else console.log(`  · ${e.type} ${e.payload_json.slice(0, 160)}`);
  }
}, 300);

const t0 = Date.now();
const buyerCard = {
  number: "4012888888881881",
  expiry: "2030-12",
  name: "Buyer Agent",
  security_code: "123",
  billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
};
const p = await runPact({ flow: { db, paypal, buyerCard, sellerEmail: config.sellerEmail }, agents }, { mandateId: mandate.id, job, scenario });
await Bun.sleep(400);
clearInterval(tail);
console.log(`\nresult    ${p.status} kind=${p.settlement_kind} accepted=${p.accepted_count}/${p.item_count} charge=${p.charge_cents}c authorized=${p.authorized_cents}c in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
