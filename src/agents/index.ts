/** Wire the real LLM-backed agents for one pact. */
import { type LlmConfig, models } from "../llm";
import type { Agents } from "../pact/run";
import { llmRubric } from "../verifier";
import { decideQuote } from "./buyer";
import { produceArtifact, quoteJob } from "./seller";

export function realAgents(cfg: LlmConfig, sessionId: string): { agents: Agents; describe: string } {
  const m = models(cfg, sessionId);
  return {
    describe: m.describe,
    agents: {
      quote: (job) => quoteJob(job, m.main),
      decide: (job, quote, mandate) => decideQuote(job, quote, mandate, m.main),
      produce: (job, onBatch) => produceArtifact(job, m.main, { batchSize: 5, concurrency: 4, onBatch }),
      rubric: llmRubric(m.fast),
    },
  };
}
