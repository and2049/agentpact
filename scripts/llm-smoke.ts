/**
 * Proves the configured LLM provider works for the two call shapes the app
 * needs: plain text and structured (zod) output, on both main and fast models.
 *   bun scripts/llm-smoke.ts
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import { loadLlmConfig, models, withFallback } from "../src/llm";

const cfg = loadLlmConfig();
const m = models(cfg, "llm-smoke");
console.log(`provider  ${m.describe}`);

const Verdict = z.object({ sku: z.string(), accepted: z.boolean(), reason: z.string() });

for (const [name, slot] of [["main", m.main], ["fast", m.fast]] as const) {
  const t0 = Date.now();
  const text = await generateText({ model: slot.model, prompt: "Reply with the single word: ready" });
  const obj = await withFallback(slot, (model) =>
    generateText({
      model,
      output: Output.object({ schema: Verdict }),
      prompt: 'Return JSON for sku "SKU-1": accepted true, reason "smoke".',
    }),
  );
  const u = obj.usage;
  console.log(
    `${name.padEnd(5)} text="${text.text.trim().slice(0, 40)}" object=${JSON.stringify(obj.output)} tokens in=${u.inputTokens} out=${u.outputTokens} reasoning=${u.outputTokenDetails?.reasoningTokens ?? 0} ${Date.now() - t0}ms`,
  );
}
