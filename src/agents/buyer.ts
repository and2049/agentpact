/** Buyer agent: posts the job and decides on the seller's quote within its mandate. */
import { generateText, Output } from "ai";
import { z } from "zod";
import { withFallback, type ModelSlot } from "../llm";
import type { Mandate } from "../mandate";
import type { JobSpec } from "../pact/types";
import type { Quote } from "./seller";

const Decision = z.object({
  accept: z.boolean(),
  message: z.string().max(400).describe("one or two sentences to the seller"),
});
export type Decision = z.infer<typeof Decision>;

/**
 * The agent reasons about the quote, but the server enforces the hard limits
 * regardless of what the model says (see pact/run.ts).
 */
export async function decideQuote(job: JobSpec, quote: Quote, mandate: Mandate, slot: ModelSlot): Promise<Decision> {
  const total = quote.unitPriceCents * job.skus.length;
  return withFallback(slot, async (model) => {
    const res = await generateText({
      model,
      output: Output.object({ schema: Decision }),
      temperature: 0.2,
      system:
        "You are a purchasing agent acting under a spending mandate from a human. You pay only for items that pass verification. " +
        "Accept a quote if the unit price is at or under your stated maximum and the total fits the mandate; otherwise reject and say why. " +
        'Respond ONLY with JSON of the exact shape {"accept":<boolean>,"message":"..."}.',
      prompt: [
        `JOB: ${job.title} (${job.skus.length} items)`,
        `YOUR MAX UNIT PRICE: ${job.maxUnitPriceCents} cents`,
        `MANDATE: max ${mandate.max_per_pact_cents} cents per pact; ${mandate.max_aggregate_cents - mandate.reserved_cents - mandate.spent_cents} cents still available overall`,
        `SELLER QUOTE: ${quote.unitPriceCents} cents per item, total ${total} cents, ETA ${quote.etaMinutes} min. Seller says: "${quote.message}"`,
      ].join("\n"),
    });
    return res.output;
  });
}
