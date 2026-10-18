import type { Verdict } from "@/lib/api"

export interface LedgerRow { sku: string; name: string; verdict: "pending" | "accepted" | "rejected"; score: number | null; reason: string; evidence: string; amount: number | null }

export function buildRows(skus: Array<{ sku: string; facts: Record<string, string | number> }>, verdicts: Verdict[], unitCents: number): LedgerRow[] {
  const by = new Map(verdicts.map((v) => [v.sku, v]))
  return skus.map((s) => {
    const v = by.get(s.sku)
    return {
      sku: s.sku,
      name: String(s.facts.name ?? ""),
      verdict: v?.verdict ?? "pending",
      score: v?.score ?? null,
      reason: v?.reason ?? "",
      evidence: (v?.evidence ?? []).join("\n"),
      amount: v ? (v.verdict === "accepted" ? unitCents : 0) : null,
    }
  })
}
