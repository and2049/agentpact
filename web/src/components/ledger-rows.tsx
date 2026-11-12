import type { Verdict } from "@/lib/api"

export interface LedgerRow { sku: string; name: string; verdict: "pending" | "accepted" | "rejected"; score: number | null; reason: string; evidence: string; amount: number | null }

/** The verifier's finding in plain words. Rubric verdicts carry a score comparison as the reason; the sentence is in the evidence. */
export function reasonText(reason: string, evidence: string[]): string {
  if (!reason.startsWith("rubric ")) return reason
  const finding = evidence.find((e) => !e.startsWith("quality "))
  const note = evidence.find((e) => e.startsWith("quality "))?.replace(/^quality \d\/5:\s*/, "")
  return finding ?? note ?? reason
}

export function buildRows(skus: Array<{ sku: string; facts: Record<string, string | number> }>, verdicts: Verdict[], unitCents: number): LedgerRow[] {
  const by = new Map(verdicts.map((v) => [v.sku, v]))
  return skus.map((s) => {
    const v = by.get(s.sku)
    return {
      sku: s.sku,
      name: String(s.facts.name ?? ""),
      verdict: v?.verdict ?? "pending",
      score: v?.score ?? null,
      reason: v ? reasonText(v.reason, v.evidence ?? []) : "",
      evidence: (v?.evidence ?? []).join("\n"),
      amount: v ? (v.verdict === "accepted" ? unitCents : 0) : null,
    }
  })
}
