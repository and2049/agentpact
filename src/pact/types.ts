import { z } from "zod";

export const SkuFacts = z.record(z.string(), z.union([z.string(), z.number()]));

export const JobSpec = z.object({
  id: z.string(),
  category: z.literal("product_descriptions"),
  title: z.string(),
  brief: z.string(),
  skus: z
    .array(z.object({ sku: z.string().min(1), facts: SkuFacts }))
    .min(1)
    .max(20),
  rubric: z.object({
    criteria: z.array(z.string()).min(1),
    /** 0..1; per-item LLM score must be >= threshold to be accepted */
    threshold: z.number().min(0).max(1),
    minWords: z.number().int().min(1),
    maxWords: z.number().int().min(1),
  }),
  maxUnitPriceCents: z.number().int().positive(),
  seller: z.string(),
});
export type JobSpec = z.infer<typeof JobSpec>;

export const Offer = z.object({
  unitPriceCents: z.number().int().positive(),
  etaMinutes: z.number().int().positive(),
  note: z.string().max(500),
});
export type Offer = z.infer<typeof Offer>;

/** One delivered item. The artifact is 0..N of these; short deliveries are valid. */
export const ArtifactItem = z.object({
  sku: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
});
export const Artifact = z.array(ArtifactItem).max(20);
export type Artifact = z.infer<typeof Artifact>;

export const ItemVerdict = z.object({
  sku: z.string(),
  verdict: z.enum(["accepted", "rejected"]),
  reason: z.string(),
  score: z.number().min(0).max(1).nullable(),
  evidence: z.array(z.string()),
});
export type ItemVerdict = z.infer<typeof ItemVerdict>;

export type PactStatus =
  | "DRAFT"
  | "OFFERED"
  | "AGREED"
  | "HELD"
  | "DELIVERED"
  | "VERIFIED"
  | "SETTLING"
  | "SETTLED"
  | "SETTLEMENT_FAILED"
  | "PAID_OUT"
  | "REJECTED"
  | "HOLD_FAILED"
  | "CHECKOUT_EXPIRED";

export type SettlementKind = "full" | "partial" | "void";

export interface PactRow {
  id: string;
  mandate_id: string;
  status: PactStatus;
  job_json: string;
  offer_json: string | null;
  pact_hash: string | null;
  unit_price_cents: number | null;
  item_count: number;
  authorized_cents: number | null;
  accepted_count: number | null;
  charge_cents: number | null;
  settlement_kind: SettlementKind | null;
  reserved_cents: number;
  order_id: string | null;
  checkout_deadline: string | null;
  hold_kind: "card" | "checkout" | null;
  /** demo: seeded buyer agent + card hold, fault injection. market: real buyer, Checkout approval. */
  kind: "demo" | "market";
  scenario: "good" | "partial" | "broken" | null;
  job_id: string | null;
  quote_id: string | null;
  agent_id: string | null;
  buyer_id: string | null;
  seller_id: string | null;
  payout_recipient: string | null;
  /** Snapshot frozen at award: offer, agent execution config, recipient. The job itself is job_json. */
  frozen_json: string | null;
  created_at: string;
  updated_at: string;
}
