/**
 * Disclosed fault injection for demo scenarios. The seller generates a real
 * artifact once; the scenario harness then damages it deterministically so the
 * verifier's verdicts are earned, not scripted.
 */
import type { Artifact, JobSpec } from "./pact/types";

export type Scenario = "good" | "partial" | "broken";

export interface FaultReport {
  scenario: Scenario;
  dropped: string[];
  corrupted: Array<{ sku: string; fact: string; from: string | number; to: string }>;
  note: string;
}

const ALTERED = "[altered]";

export function injectFault(job: JobSpec, artifact: Artifact, scenario: Scenario): { raw: unknown; report: FaultReport } {
  if (scenario === "good") return { raw: artifact, report: { scenario, dropped: [], corrupted: [], note: "artifact delivered as generated" } };

  if (scenario === "broken") {
    // Valid JSON, wrong shape: items keyed by sku instead of an array.
    const obj: Record<string, unknown> = {};
    for (const it of artifact) obj[it.sku] = { title: it.title, body: it.description };
    return { raw: obj, report: { scenario, dropped: [], corrupted: [], note: "artifact re-shaped into an object keyed by sku (schema violation)" } };
  }

  // partial: drop every 4th item (5 of 20) and corrupt one fact in every 5th remaining item (3 of 15).
  const dropped: string[] = [];
  const corrupted: FaultReport["corrupted"] = [];
  const out: Artifact = [];
  artifact.forEach((it, i) => {
    if (i % 4 === 3) {
      dropped.push(it.sku);
      return;
    }
    const copy = { ...it };
    if (out.length % 5 === 2) {
      const facts = job.skus.find((s) => s.sku === it.sku)?.facts ?? {};
      const stringFact = Object.entries(facts).find(([, v]) => typeof v === "string" && copy.description.toLowerCase().includes(String(v).toLowerCase()));
      if (stringFact) {
        const [k, v] = stringFact;
        const re = new RegExp(String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        copy.description = copy.description.replace(re, ALTERED);
        copy.title = copy.title.replace(re, ALTERED);
        corrupted.push({ sku: it.sku, fact: k, from: v, to: ALTERED });
      }
    }
    out.push(copy);
  });
  return { raw: out, report: { scenario, dropped, corrupted, note: `dropped ${dropped.length} items, corrupted a fact in ${corrupted.length}` } };
}
