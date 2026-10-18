/**
 * Proves the configured LLM provider works for the two call shapes the app
 * needs: plain text and structured (zod) output, on both main and fast models.
 *   bun scripts/llm-smoke.ts
 */
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { loadLlmConfig, models } from "../src/llm";

const cfg = loadLlmConfig();
const m = models(cfg);
console.log(`provider  ${m.describe}`);

for (const [name, model] of [["main", m.main], ["fast", m.fast]] as const) {
  const t0 = Date.now();
  const text = await generateText({ model, prompt: "Reply with the single word: ready" });
  const obj = await generateObject({
    model,
    schema: z.object({ sku: z.string(), accepted: z.boolean(), reason: z.string() }),
    prompt: 'Return JSON for sku "SKU-1": accepted true, reason "smoke".',
  });
  console.log(`${name.padEnd(5)} text="${text.text.trim().slice(0, 40)}" object=${JSON.stringify(obj.object)} usage=${JSON.stringify(text.usage)} ${Date.now() - t0}ms`);
}
