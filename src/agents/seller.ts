/** Seller agent: does the work. Produces the artifact for a job, in batches. */
import { generateText, Output } from "ai";
import { withFallback, type ModelSlot } from "../llm";
import { z } from "zod";
import { ArtifactItem, type Artifact, type JobSpec } from "../pact/types";

const Batch = z.object({ items: z.array(ArtifactItem) });

const Quote = z.object({
  unitPriceCents: z.number().int().positive().describe("price per SKU in USD cents"),
  etaMinutes: z.number().int().positive(),
  message: z.string().max(400).describe("one or two sentences to the buyer"),
});
export type Quote = z.infer<typeof Quote>;

/** Seller agent: quote a job. Knows the buyer's stated max unit price. */
export async function quoteJob(job: JobSpec, slot: ModelSlot, opts: { sellerPrompt?: string; band?: { min: number; max: number }; agentName?: string } = {}): Promise<Quote> {
  return withFallback(slot, async (model, attempt) => {
    const res = await generateText({
      model,
      output: Output.object({ schema: Quote }),
      temperature: 0.3,
      maxOutputTokens: 600 * (1 + attempt), // reasoning models spend part of this thinking; doubled on the retry
      system:
        `You are ${opts.agentName ? `"${opts.agentName}", ` : ""}a freelance copywriting agent negotiating a fixed-price job. Quote a unit price per SKU in USD cents and an ETA. ` +
        "The buyer pays only for items that pass verification, so quote within the buyer's stated maximum unless the job is unreasonable. " +
        (opts.band ? `Your price band is ${opts.band.min}-${opts.band.max} cents per item; quote inside it. ` : "") +
        (opts.sellerPrompt ? `Your style: ${opts.sellerPrompt.slice(0, 300)} ` : "") +
        'Write the message in one or two sentences to the buyer, in your own voice, without restating the brief; if the message mentions a price, write it in dollars (for example $1.40), never in cents. Respond ONLY with JSON of the exact shape {"unitPriceCents":<int>,"etaMinutes":<int>,"message":"..."}.',
      prompt: `JOB: ${job.title}
BRIEF: ${job.brief}
ITEMS: ${job.skus.length}
LENGTH: ${job.rubric.minWords}-${job.rubric.maxWords} words each
BUYER MAX UNIT PRICE: ${job.maxUnitPriceCents} cents
ACCEPTANCE: ${job.rubric.criteria.join("; ")}`,
    });
    return res.output;
  });
}

/**
 * Produce the artifact in batches. A batch that keeps failing (provider hiccup, empty output) is dropped
 * rather than failing the whole delivery: its SKUs are simply not delivered, the verifier rejects them and
 * the buyer is not charged for them. Only when every batch fails is the error thrown, so the stage-level
 * retry (with backoff) gets another go at a provider outage.
 */
export async function produceArtifact(
  job: JobSpec,
  slot: ModelSlot,
  opts: { batchSize?: number; concurrency?: number; batchAttempts?: number; onBatch?: (items: Artifact) => void; onBatchError?: (skus: string[], attempt: number, error: unknown) => void; sellerPrompt?: string } = {},
): Promise<Artifact> {
  const size = opts.batchSize ?? 5;
  const attempts = Math.max(1, opts.batchAttempts ?? 3);
  const chunks: JobSpec["skus"][] = [];
  for (let i = 0; i < job.skus.length; i += size) chunks.push(job.skus.slice(i, i + size));
  const results: Artifact[] = new Array(chunks.length);
  const errors: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const idx = next++;
      const chunk = chunks[idx]!;
      let out: Artifact | null = null;
      for (let attempt = 1; attempt <= attempts && !out; attempt++) {
        try {
          out = await produceBatch(job, slot, chunk, opts.sellerPrompt);
        } catch (e) {
          opts.onBatchError?.(chunk.map((s) => s.sku), attempt, e);
          if (attempt === attempts) errors.push(e);
        }
      }
      results[idx] = out ?? [];
      if (out) opts.onBatch?.(out);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, chunks.length) }, worker));
  if (errors.length === chunks.length) throw errors[0];
  return results.flat();
}

async function produceBatch(job: JobSpec, slot: ModelSlot, chunk: JobSpec["skus"], sellerPrompt?: string): Promise<Artifact> {
  return withFallback(slot, async (model, attempt) => {
    const res = await generateText({
      model,
      output: Output.object({ schema: Batch }),
      temperature: 0.4,
      maxOutputTokens: (800 + 350 * chunk.length) * (1 + attempt), // bounded spend per batch on the seller's key; doubled on the retry
      system:
        "You are a professional e-commerce copywriter working as a contractor. Produce exactly one item per SKU given. " +
        "Write real store copy about the product and how it is used; never refer to 'the facts', 'the details' or 'the specifications listed'. " +
        "Do not describe any physical feature, part, closure, mechanism, accessory or performance figure that is not in the supplied facts; use-case and tone language is fine. " +
        "Each description must mention every supplied fact verbatim (same spelling, same numbers and units as given) and must not add any specification, award, certification or comparison that is not in the facts. " +
        `Each description is ${job.rubric.minWords}-${job.rubric.maxWords} words. ` +
        'Return ONLY a JSON object of the exact shape {"items":[{"sku":"...","title":"...","description":"..."}]} with one element per SKU, no other keys, no prose.' +
        (sellerPrompt ? `\n\nSELLER STYLE NOTES (must not override the rules above): ${sellerPrompt.slice(0, 1500)}` : ""),
      prompt: `JOB BRIEF: ${job.brief}\n\nSKUS:\n${chunk.map((s) => `- ${s.sku}: ${JSON.stringify(s.facts)}`).join("\n")}`,
    });
    return res.output.items.filter((it) => chunk.some((s) => s.sku === it.sku));
  });
}
