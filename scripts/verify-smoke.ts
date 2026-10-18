/**
 * Seller work + verifier on the real LLM, no PayPal:
 *   bun scripts/verify-smoke.ts [good|partial|broken]
 * Generates the 20-item artifact once, injects the scenario fault, verifies,
 * prints per-item verdicts and the settlement that would follow.
 */
import { produceArtifact } from "../src/agents/seller";
import { injectFault, type Scenario } from "../src/faults";
import { sampleJob } from "../src/jobs/sample";
import { loadLlmConfig, models } from "../src/llm";
import { computeSettlement } from "../src/settlement";
import { llmRubric, verify } from "../src/verifier";

const scenario = (process.argv[2] ?? "good") as Scenario;
const m = models(loadLlmConfig(), `verify-smoke-${Date.now()}`);
const job = sampleJob("seller@example.com");
console.log(`provider  ${m.describe}\nscenario  ${scenario}`);

let t0 = Date.now();
const artifact = await produceArtifact(job, m.main, { onBatch: (b) => process.stdout.write(`  seller produced ${b.map((i) => i.sku).join(",")}\n`) });
console.log(`seller    ${artifact.length} items in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await Bun.write(`runs/artifact-${scenario}-${Date.now()}.json`, JSON.stringify(artifact, null, 2));

const { raw, report } = injectFault(job, artifact, scenario);
console.log(`fault     ${report.note}${report.dropped.length ? `; dropped ${report.dropped.join(",")}` : ""}${report.corrupted.length ? `; corrupted ${report.corrupted.map((c) => `${c.sku}.${c.fact}`).join(",")}` : ""}`);

t0 = Date.now();
const verdicts = await verify(job, raw, { rubric: llmRubric(m.fast), concurrency: 4 });
console.log(`verify    ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const v of verdicts) console.log(`  ${v.sku}  ${v.verdict.padEnd(8)} ${v.score === null ? "  -  " : v.score.toFixed(2)}  ${v.reason}${v.evidence.length ? ` | ${v.evidence[0]}` : ""}`);
const s = computeSettlement({ verdicts, itemCount: job.skus.length, unitPriceCents: 100 });
console.log(`settle    ${s.kind}: ${s.acceptedCount}/${job.skus.length} accepted -> charge ${s.chargeCents}c, release ${s.releasedCents}c`);
