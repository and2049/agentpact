/** Pure settlement arithmetic. Integer cents only. */
import type { ItemVerdict, SettlementKind } from "./pact/types";

export interface Settlement {
  kind: SettlementKind;
  acceptedCount: number;
  rejectedCount: number;
  chargeCents: number;
  releasedCents: number;
}

export function computeSettlement(args: { verdicts: ItemVerdict[]; itemCount: number; unitPriceCents: number }): Settlement {
  const { verdicts, itemCount, unitPriceCents } = args;
  if (!Number.isInteger(unitPriceCents) || unitPriceCents <= 0) throw new Error("unitPriceCents must be a positive integer");
  if (!Number.isInteger(itemCount) || itemCount <= 0) throw new Error("itemCount must be a positive integer");
  const seen = new Set<string>();
  let accepted = 0;
  for (const v of verdicts) {
    if (seen.has(v.sku)) throw new Error(`duplicate verdict for ${v.sku}`);
    seen.add(v.sku);
    if (v.verdict === "accepted") accepted++;
  }
  if (accepted > itemCount) throw new Error("accepted count exceeds item count");
  const authorized = itemCount * unitPriceCents;
  const chargeCents = accepted * unitPriceCents;
  const kind: SettlementKind = accepted === 0 ? "void" : accepted === itemCount ? "full" : "partial";
  return {
    kind,
    acceptedCount: accepted,
    rejectedCount: itemCount - accepted,
    chargeCents,
    releasedCents: authorized - chargeCents,
  };
}
