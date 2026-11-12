/** Thin JSON client over the AgentPact API (see README § API). Every page is a function of these shapes. */

export class ApiError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message)
    this.status = status
    this.body = body
  }
  /** Server validation issues, when present. */
  get issues(): string[] {
    const i = this.body.issues
    return Array.isArray(i) ? i.map(String) : []
  }
  get detail(): string {
    const m = typeof this.body.message === "string" ? this.body.message : null
    return [m ?? this.message, ...this.issues].join(" · ")
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const r = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  })
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!r.ok) throw new ApiError(typeof j.error === "string" ? j.error : `HTTP ${r.status}`, r.status, j)
  return j as T
}

export const errorText = (e: unknown): string => (e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e))

// ---------- shapes ----------
export type PactStatus =
  | "DRAFT" | "OFFERED" | "AGREED" | "HELD" | "DELIVERED" | "VERIFIED" | "SETTLING" | "SETTLED" | "PAID_OUT"
  | "REJECTED" | "HOLD_FAILED" | "SETTLEMENT_FAILED" | "CHECKOUT_EXPIRED"
export type JobStatus = "OPEN" | "AWARDED" | "CLOSED"
export type QuoteStatus = "pending" | "open" | "awarded" | "lost"
export type Role = "buyer" | "seller" | "verifier" | "platform"

export interface User { id: string; provider: "paypal" | "dev"; provider_user_id?: string; name: string; email: string; operator?: boolean }
export interface Config { clientId: string; env: string; devLogin: boolean; keyCustody: boolean; templates: Array<{ id: string; name: string; rubric: { minWords: number; maxWords: number; criteria?: string[] } }> }

export type Facts = Record<string, string | number>
export interface JobItem { sku: string; facts: Facts }

export interface JobSummary {
  id: string; template: string; title: string; brief: string; item_count: number; max_unit_price_cents: number
  status: JobStatus; buyer_name: string; quote_count: number; created_at: string
  /** Direct hire: the one agent invited to quote. */
  agent_id?: string | null; agent_name?: string | null
}
export interface AgentStats { settled: number; acceptanceRate: number | null; earnedCents: number }
export interface Agent {
  id: string; owner_id: string; name: string; description: string; provider: string; model: string | null
  min_unit_price_cents: number; max_unit_price_cents: number; max_items_per_job: number; status: "active" | "paused"
  created_at: string; stats: AgentStats; has_key?: boolean; system_prompt?: string; max_quotes_per_day?: number
}
export interface AgentWork { id: string; title: string; item_count: number; accepted_count: number | null; unit_price_cents: number | null; settlement_kind: string | null; updated_at: string }
export interface Quote {
  id: string; job_id: string; agent_id: string; seller_id: string; status: QuoteStatus; unit_price_cents: number
  eta_minutes: number; message: string; created_at: string; agent: Agent | null; seller_name: string
}
export interface JobDetail extends JobSummary {
  buyer_id: string; pact_id: string | null; mine: boolean; restricted?: boolean
  items?: JobItem[]; rubric?: { minWords: number; maxWords: number; criteria: string[] }; quotes?: Quote[]; quoting?: boolean
}

export interface PactSummary {
  id: string; kind: "demo" | "market"; scenario: "good" | "partial" | "broken" | null; status: PactStatus; title: string
  item_count: number; unit_price_cents: number | null; authorized_cents: number | null; accepted_count: number | null
  charge_cents: number | null; settlement_kind: "full" | "partial" | "void" | null; job_id: string | null; buyer_id: string | null; seller_id: string | null; created_at: string; updated_at: string
}
export interface Verdict { sku: string; verdict: "accepted" | "rejected"; reason: string; score: number | null; evidence: string[] }
export interface PactDetail {
  pact: {
    id: string; status: PactStatus; kind: "demo" | "market"; scenario: string | null; unit_price_cents: number | null; item_count: number
    authorized_cents: number | null; accepted_count: number | null; charge_cents: number | null; settlement_kind: string | null
    order_id: string | null; checkout_deadline: string | null; pact_hash: string | null; job_id: string | null
    buyer_name: string | null; seller_name: string | null; created_at: string; updated_at: string
  }
  job: { id: string; title: string; brief: string; skus: JobItem[]; rubric?: { minWords?: number; maxWords?: number } }
  agent: Agent | null
  viewer: { id: string; role: "buyer" | "seller" | "viewer" } | null
  can_approve: boolean
  authorization: { id: string; status: string; order_id: string } | null
  capture: { id: string; status: string } | null
  payout: { item_id: string; status: string; receiver: string; amount_cents: number } | null
  items: Verdict[]
}
export interface Deliverable { accepted: Array<{ sku: string; title: string; description: string }>; rejected: Array<{ sku: string; reason: string }>; settled: boolean }
export interface Settlement { title: string; agent_id: string | null; agent_name: string | null; item_count: number; accepted_count: number; unit_price_cents: number; authorized_cents: number; charge_cents: number; settlement_kind: string | null; settled_at: string }
export interface MarketStats {
  totals: { pacts: number; items: number; accepted: number; capturedCents: number; releasedCents: number; paidOutCents: number; agents: number }
  recent: Settlement[]
}
export interface Mandate { id: string; max_per_pact_cents: number; max_aggregate_cents: number; reserved_cents: number; spent_cents: number }
export interface Me { user: User; mandate: Mandate; jobs: JobSummary[]; agents: Agent[]; pacts: { asBuyer: PactSummary[]; asSeller: PactSummary[] }; earnedCents: number }
