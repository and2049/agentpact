/**
 * Seller key custody end to end, no PayPal:
 *   seal the provider key from .env under a throwaway AGENT_KEY_SECRET -> store a keyed agent
 *   -> llmConfigForAgent decrypts it -> quote + produce 2 items on the seller's own key.
 *
 *   bun scripts/agent-smoke.ts            # uses LLM_PROVIDER / *_API_KEY / LLM_MODEL from .env
 */
import { upsertUser } from "../src/auth";
import { openDb } from "../src/db";
import { loadLlmConfig, models } from "../src/llm";
import { createAgent, getAgent, llmConfigForAgent, publicAgent, type AgentDeps } from "../src/market/agents";
import { createJob, eligibleAgents, jobSpecOf, recordQuote } from "../src/market/jobs";
import { produceArtifact, quoteJob } from "../src/agents/seller";

const platform = loadLlmConfig();
const provider = platform.provider === "openai-compatible" ? null : platform.provider;
if (!provider) {
  console.error("agent-smoke needs LLM_PROVIDER opencode|anthropic|openai (openai-compatible has no agent provider)");
  process.exit(2);
}
const db = openDb();
const secret = `smoke-${crypto.randomUUID()}`;
const deps: AgentDeps = { db, env: { AGENT_KEY_SECRET: secret, ...process.env } };
const seller = upsertUser(db, { provider: "paypal", providerUserId: "smoke-seller", name: "Smoke Seller", email: "smoke-seller@example.com" });
const buyer = upsertUser(db, { provider: "paypal", providerUserId: "smoke-buyer", name: "Smoke Buyer", email: "smoke-buyer@example.com" });

const agent = await createAgent(deps, seller.id, {
  name: "Keyed Copywriter",
  description: "runs on the seller's own key",
  provider,
  model: platform.model,
  apiKey: platform.apiKey,
  systemPrompt: "Prefer short, warm sentences.",
  minUnitPriceCents: 40,
  maxUnitPriceCents: 150,
  maxItemsPerJob: 20,
  maxQuotesPerDay: 20,
  status: "active",
});
const stored = getAgent(db, agent.id)!;
const pub = JSON.stringify(publicAgent(db, stored, seller.id));
console.log(`sealed      ${stored.api_key_enc!.slice(0, 18)}…  (plaintext in API response: ${pub.includes(platform.apiKey) ? "YES, BUG" : "no"}; in sealed column: ${stored.api_key_enc!.includes(platform.apiKey) ? "YES, BUG" : "no"})`);

const job = createJob(db, buyer.id, {
  template: "product_descriptions",
  title: "Two mugs",
  brief: "Write one product description per SKU for an online homeware store. Mention every supplied fact exactly as given. No invented claims.",
  items: [
    { sku: "MUG-1", facts: { name: "Harbor Stoneware Mug", capacity_ml: 350, color: "sea green" } },
    { sku: "MUG-2", facts: { name: "Ridge Travel Tumbler", capacity_ml: 450, material: "stainless steel" } },
  ],
  maxUnitPriceCents: 120,
});
console.log(`eligible    ${eligibleAgents(db, job).map((a) => a.name).join(", ") || "(none)"}`);

const cfg = await llmConfigForAgent(deps, stored);
console.log(`decrypted   provider=${cfg.provider} model=${cfg.model} key=${cfg.apiKey === platform.apiKey ? "matches" : "MISMATCH"}`);
const spec = jobSpecOf(job, seller.email);
const m = models(cfg, `agent-smoke-${agent.id}`);
const t0 = Date.now();
const q = await quoteJob(spec, m.main);
const row = recordQuote(db, job, stored, q);
console.log(`quote       ${q.unitPriceCents}¢ -> clamped ${row.unit_price_cents}¢, eta ${q.etaMinutes} min: ${q.message.slice(0, 100)}`);
const art = await produceArtifact(spec, m.main, { batchSize: 5, concurrency: 2, sellerPrompt: stored.system_prompt });
for (const it of art) console.log(`  ${it.sku}  ${it.title}: ${it.description.split(/\s+/).length} words`);
console.log(`done        ${art.length} items in ${((Date.now() - t0) / 1000).toFixed(1)}s on the seller's key`);
