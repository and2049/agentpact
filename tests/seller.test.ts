import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { produceArtifact } from "../src/agents/seller";
import { sampleJob } from "../src/jobs/sample";
import type { ModelSlot } from "../src/llm";

const job = sampleJob("seller@example.com");

/** A model that answers each batch with one item per SKU, or throws when `failWhen` says so. */
function fakeModel(failWhen: (call: number, prompt: string) => boolean) {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const call = ++calls;
      const user = opts.prompt.find((m) => m.role === "user");
      const text = user && Array.isArray(user.content) ? user.content.map((c) => ("text" in c ? c.text : "")).join("") : "";
      if (failWhen(call, text)) throw new Error("No output generated.");
      const skus = [...text.matchAll(/^- (TRK-\d+):/gm)].map((m) => m[1]!);
      const items = skus.map((sku) => ({ sku, title: sku, description: `Copy for ${sku}.` }));
      return {
        content: [{ type: "text", text: JSON.stringify({ items }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  return { model, calls: () => calls };
}
const slotOf = (m: MockLanguageModelV3): ModelSlot => ({ model: m as never, fallback: null as never });

describe("produceArtifact batch resilience", () => {
  test("a batch that fails once is retried and the full artifact is delivered", async () => {
    const seen = new Set<string>();
    const { model, calls } = fakeModel((_, prompt) => {
      // Fail the first attempt of the batch that contains TRK-006 only.
      if (prompt.includes("TRK-006") && !seen.has("TRK-006")) {
        seen.add("TRK-006");
        return true;
      }
      return false;
    });
    const errors: string[][] = [];
    const out = await produceArtifact(job, slotOf(model), { batchSize: 5, concurrency: 2, onBatchError: (skus) => errors.push(skus) });
    expect(out.map((i) => i.sku).sort()).toEqual(job.skus.map((s) => s.sku).sort());
    expect(errors.length).toBe(1);
    expect(calls()).toBe(job.skus.length / 5 + 1);
  });

  test("a batch that keeps failing is dropped; the rest is delivered", async () => {
    const { model } = fakeModel((_, prompt) => prompt.includes("TRK-011"));
    const out = await produceArtifact(job, slotOf(model), { batchSize: 5, concurrency: 1, batchAttempts: 2 });
    expect(out.length).toBe(job.skus.length - 5);
    expect(out.some((i) => i.sku === "TRK-011")).toBe(false);
  });

  test("when every batch fails the error propagates so the stage can retry later", async () => {
    const { model } = fakeModel(() => true);
    await expect(produceArtifact(job, slotOf(model), { batchSize: 5, batchAttempts: 1 })).rejects.toThrow("No output generated.");
  });
});
