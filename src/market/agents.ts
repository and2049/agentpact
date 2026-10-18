/**
 * Seller-owned hosted agents. Provider + model from an allowlist; the API key
 * is sealed at rest and write-only. `platform` agents run on the platform's
 * own LLM configuration (used for the seeded demo seller).
 */
import { z } from "zod";
import { open, seal } from "../crypto";
import { now, type Db } from "../db";
import { loadLlmConfig, type LlmConfig, type ProviderName } from "../llm";

export const AGENT_PROVIDERS = ["platform", "opencode", "anthropic", "openai"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  provider: AgentProvider;
  model: string;
  api_key_enc: string | null;
  system_prompt: string;
  min_unit_price_cents: number;
  max_unit_price_cents: number;
  max_items_per_job: number;
  max_quotes_per_day: number;
  status: "active" | "paused";
  created_at: string;
  updated_at: string;
}

export const AgentInput = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(500).default(""),
    provider: z.enum(AGENT_PROVIDERS),
    model: z.string().trim().max(80).default(""),
    apiKey: z.string().trim().max(400).optional(),
    systemPrompt: z.string().trim().max(2000).default(""),
    minUnitPriceCents: z.number().int().min(1).max(100_000),
    maxUnitPriceCents: z.number().int().min(1).max(100_000),
    maxItemsPerJob: z.number().int().min(1).max(20).default(20),
    maxQuotesPerDay: z.number().int().min(1).max(200).default(20),
    status: z.enum(["active", "paused"]).default("active"),
  })
  .refine((a) => a.minUnitPriceCents <= a.maxUnitPriceCents, { message: "minUnitPriceCents must be <= maxUnitPriceCents" })
  .refine((a) => a.provider === "platform" || a.model.length > 0, { message: "model is required for a keyed provider" });
export type AgentInput = z.infer<typeof AgentInput>;

export class AgentError extends Error {
  constructor(
    public code: "forbidden" | "not_found" | "custody" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export interface AgentDeps {
  db: Db;
  env: Record<string, string | undefined>;
}

const secretOf = (env: Record<string, string | undefined>) => env.AGENT_KEY_SECRET ?? "";

export async function createAgent(deps: AgentDeps, ownerId: string, input: AgentInput): Promise<AgentRow> {
  const { db } = deps;
  if (input.provider !== "platform" && !input.apiKey) throw new AgentError("invalid", "apiKey is required for a keyed provider");
  if (input.provider === "platform" && ownerIsNotPlatform(deps, ownerId)) throw new AgentError("forbidden", "the platform provider is reserved for seeded agents; bring your own key");
  const enc = input.apiKey ? await seal(input.apiKey, secretOrThrow(deps)) : null;
  const id = crypto.randomUUID();
  const ts = now();
  db.run(
    `INSERT INTO agents (id, owner_id, name, description, provider, model, api_key_enc, system_prompt, min_unit_price_cents, max_unit_price_cents, max_items_per_job, max_quotes_per_day, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ownerId, input.name, input.description, input.provider, input.model, enc, input.systemPrompt, input.minUnitPriceCents, input.maxUnitPriceCents, input.maxItemsPerJob, input.maxQuotesPerDay, input.status, ts, ts],
  );
  return getAgent(db, id)!;
}

function secretOrThrow(deps: AgentDeps): string {
  const s = secretOf(deps.env);
  if (!s) throw new AgentError("custody", "key custody is not configured on this server (AGENT_KEY_SECRET)");
  return s;
}

/** Only seeded (dev-provider) accounts may create agents that run on the platform's key. */
function ownerIsNotPlatform(deps: AgentDeps, ownerId: string): boolean {
  const u = deps.db.query<{ provider: string }, [string]>("SELECT provider FROM users WHERE id = ?").get(ownerId);
  return u?.provider !== "dev";
}

export async function updateAgent(deps: AgentDeps, ownerId: string, id: string, patch: Partial<AgentInput>): Promise<AgentRow> {
  const { db } = deps;
  const cur = getAgent(db, id);
  if (!cur) throw new AgentError("not_found", "agent not found");
  if (cur.owner_id !== ownerId) throw new AgentError("forbidden", "not your agent");
  const merged = AgentInput.parse({
    name: patch.name ?? cur.name,
    description: patch.description ?? cur.description,
    provider: patch.provider ?? cur.provider,
    model: patch.model ?? cur.model,
    apiKey: patch.apiKey,
    systemPrompt: patch.systemPrompt ?? cur.system_prompt,
    minUnitPriceCents: patch.minUnitPriceCents ?? cur.min_unit_price_cents,
    maxUnitPriceCents: patch.maxUnitPriceCents ?? cur.max_unit_price_cents,
    maxItemsPerJob: patch.maxItemsPerJob ?? cur.max_items_per_job,
    maxQuotesPerDay: patch.maxQuotesPerDay ?? cur.max_quotes_per_day,
    status: patch.status ?? cur.status,
  });
  if (merged.provider === "platform" && cur.provider !== "platform" && ownerIsNotPlatform(deps, ownerId)) throw new AgentError("forbidden", "the platform provider is reserved for seeded agents");
  const enc = merged.apiKey ? await seal(merged.apiKey, secretOrThrow(deps)) : cur.api_key_enc;
  if (merged.provider !== "platform" && !enc) throw new AgentError("invalid", "apiKey is required for a keyed provider");
  db.run(
    `UPDATE agents SET name = ?, description = ?, provider = ?, model = ?, api_key_enc = ?, system_prompt = ?, min_unit_price_cents = ?, max_unit_price_cents = ?, max_items_per_job = ?, max_quotes_per_day = ?, status = ?, updated_at = ? WHERE id = ?`,
    [merged.name, merged.description, merged.provider, merged.model, enc, merged.systemPrompt, merged.minUnitPriceCents, merged.maxUnitPriceCents, merged.maxItemsPerJob, merged.maxQuotesPerDay, merged.status, now(), id],
  );
  return getAgent(db, id)!;
}

/** Remove the stored key. A keyed agent without a key is paused until a new key is supplied. */
export function deleteAgentKey(db: Db, ownerId: string, id: string): AgentRow {
  const cur = getAgent(db, id);
  if (!cur) throw new AgentError("not_found", "agent not found");
  if (cur.owner_id !== ownerId) throw new AgentError("forbidden", "not your agent");
  db.run("UPDATE agents SET api_key_enc = NULL, status = CASE WHEN provider = 'platform' THEN status ELSE 'paused' END, updated_at = ? WHERE id = ?", [now(), id]);
  return getAgent(db, id)!;
}

export function getAgent(db: Db, id: string): AgentRow | null {
  return db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id) ?? null;
}

export function listAgents(db: Db, opts: { ownerId?: string; activeOnly?: boolean } = {}): AgentRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.ownerId) {
    where.push("owner_id = ?");
    args.push(opts.ownerId);
  }
  if (opts.activeOnly) where.push("status = 'active'");
  return db.query<AgentRow, string[]>(`SELECT * FROM agents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at`).all(...args);
}

export interface AgentStats {
  settled: number;
  items: number;
  accepted: number;
  acceptanceRate: number | null;
  earnedCents: number;
}

export function agentStats(db: Db, agentId: string): AgentStats {
  const r = db
    .query<{ settled: number; items: number; accepted: number; earned: number }, [string]>(
      `SELECT count(*) AS settled, coalesce(sum(item_count), 0) AS items, coalesce(sum(accepted_count), 0) AS accepted,
              coalesce(sum(CASE WHEN status = 'PAID_OUT' THEN charge_cents ELSE 0 END), 0) AS earned
       FROM pacts WHERE agent_id = ? AND status IN ('SETTLED', 'PAID_OUT')`,
    )
    .get(agentId)!;
  return { settled: r.settled, items: r.items, accepted: r.accepted, acceptanceRate: r.items ? r.accepted / r.items : null, earnedCents: r.earned };
}

/** What the API returns: never the key, and limits only to the owner. */
export function publicAgent(db: Db, a: AgentRow, viewerId?: string | null) {
  const base = {
    id: a.id,
    owner_id: a.owner_id,
    name: a.name,
    description: a.description,
    provider: a.provider,
    model: a.provider === "platform" ? "platform default" : a.model,
    min_unit_price_cents: a.min_unit_price_cents,
    max_unit_price_cents: a.max_unit_price_cents,
    max_items_per_job: a.max_items_per_job,
    status: a.status,
    created_at: a.created_at,
    stats: agentStats(db, a.id),
  };
  if (viewerId && viewerId === a.owner_id) return { ...base, has_key: Boolean(a.api_key_enc), system_prompt: a.system_prompt, max_quotes_per_day: a.max_quotes_per_day, model: a.model };
  return base;
}

/** The LLM configuration an agent runs on. Decrypts the seller key only here. */
export async function llmConfigForAgent(deps: AgentDeps, a: AgentRow): Promise<LlmConfig> {
  if (a.provider === "platform") return loadLlmConfig(deps.env);
  if (!a.api_key_enc) throw new AgentError("invalid", "agent has no API key");
  const apiKey = await open(a.api_key_enc, secretOrThrow(deps));
  const provider: ProviderName = a.provider;
  return { provider, model: a.model, fastModel: a.model, apiKey };
}

export function quotesTodayFor(db: Db, agentId: string): number {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  return db.query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM quotes WHERE agent_id = ? AND created_at > ?").get(agentId, since)!.n;
}

/** Idempotent seeded demo agent for the dev seller account. */
export function ensureSeedAgent(db: Db, ownerId: string): AgentRow {
  const existing = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE owner_id = ? AND provider = 'platform' ORDER BY created_at LIMIT 1").get(ownerId);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const ts = now();
  db.run(
    `INSERT INTO agents (id, owner_id, name, description, provider, model, api_key_enc, system_prompt, min_unit_price_cents, max_unit_price_cents, max_items_per_job, max_quotes_per_day, status, created_at, updated_at)
     VALUES (?, ?, 'Copywriter One', 'Seeded demo seller: product descriptions on the platform model. Paid per accepted item.', 'platform', '', NULL, '', 50, 200, 20, 100, 'active', ?, ?)`,
    [id, ownerId, ts, ts],
  );
  return getAgent(db, id)!;
}
