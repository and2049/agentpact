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
  /** Provider the sealed key was issued for; a frozen pact refuses a key of another provider. */
  key_provider: AgentProvider | null;
  system_prompt: string;
  min_unit_price_cents: number;
  max_unit_price_cents: number;
  max_items_per_job: number;
  max_quotes_per_day: number;
  status: "active" | "paused";
  created_at: string;
  updated_at: string;
}

/** Model ids a seller may run on, per provider (quoting and production spend the seller's key). */
export const MODEL_ALLOWLIST: Record<Exclude<AgentProvider, "platform">, RegExp> = {
  opencode: /^(glm-|kimi-|qwen|deepseek-|claude-|gpt-|grok-|muse-spark-|minimax-|gemini-)[a-z0-9.\-]+$/i,
  anthropic: /^claude-[a-z0-9.\-]+$/i,
  openai: /^(gpt-|o[0-9])[a-z0-9.\-]+$/i,
};
export function modelAllowed(provider: AgentProvider, model: string): boolean {
  if (provider === "platform") return true;
  return MODEL_ALLOWLIST[provider].test(model) && model.length <= 80;
}

const AgentFields = {
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500),
  provider: z.enum(AGENT_PROVIDERS),
  model: z.string().trim().max(80),
  apiKey: z.string().trim().min(16).max(400).optional(),
  systemPrompt: z.string().trim().max(2000),
  minUnitPriceCents: z.number().int().min(1).max(100_000),
  maxUnitPriceCents: z.number().int().min(1).max(100_000),
  maxItemsPerJob: z.number().int().min(1).max(20),
  maxQuotesPerDay: z.number().int().min(1).max(200),
  status: z.enum(["active", "paused"]),
};
export const AgentInput = z
  .object({ ...AgentFields, description: AgentFields.description.default(""), model: AgentFields.model.default(""), systemPrompt: AgentFields.systemPrompt.default(""), maxItemsPerJob: AgentFields.maxItemsPerJob.default(20), maxQuotesPerDay: AgentFields.maxQuotesPerDay.default(20), status: AgentFields.status.default("active") })
  .refine((a) => a.minUnitPriceCents <= a.maxUnitPriceCents, { message: "minUnitPriceCents must be <= maxUnitPriceCents" })
  .refine((a) => a.provider === "platform" || a.model.length > 0, { message: "model is required for a keyed provider" })
  .refine((a) => modelAllowed(a.provider, a.model), { message: "model is not on the allowlist for this provider" });
/** PATCH body: every field optional, no defaults, no object-level refinements (those run on the merged agent). */
export const AgentPatch = z.object(Object.fromEntries(Object.entries(AgentFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof AgentFields]: z.ZodOptional<(typeof AgentFields)[K]> });
export type AgentPatch = z.infer<typeof AgentPatch>;
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

/**
 * Platform-hosted agents run on the platform's own model key, so anyone can play seller without
 * bringing a key. They are capped: few per user, small jobs, few quotes a day. BYO-key agents are not.
 */
export const PLATFORM_AGENT_LIMITS = { perUser: 2, maxItemsPerJob: 10, maxQuotesPerDay: 10 };

function applyPlatformLimits(input: AgentInput): AgentInput {
  if (input.provider !== "platform") return input;
  return { ...input, maxItemsPerJob: Math.min(input.maxItemsPerJob, PLATFORM_AGENT_LIMITS.maxItemsPerJob), maxQuotesPerDay: Math.min(input.maxQuotesPerDay, PLATFORM_AGENT_LIMITS.maxQuotesPerDay) };
}

export async function createAgent(deps: AgentDeps, ownerId: string, raw: AgentInput): Promise<AgentRow> {
  const { db } = deps;
  const input = applyPlatformLimits(raw);
  if (input.provider !== "platform" && !input.apiKey) throw new AgentError("invalid", "apiKey is required for a keyed provider");
  if (input.provider === "platform") {
    const n = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM agents WHERE owner_id = ? AND provider = 'platform'").get(ownerId)!.n;
    if (n >= PLATFORM_AGENT_LIMITS.perUser && !isSeedOwner(deps, ownerId)) throw new AgentError("invalid", `at most ${PLATFORM_AGENT_LIMITS.perUser} platform-hosted agents per account; bring your own key for more`);
  }
  const enc = input.apiKey ? await seal(input.apiKey, secretOrThrow(deps)) : null;
  const id = crypto.randomUUID();
  const ts = now();
  db.run(
    `INSERT INTO agents (id, owner_id, name, description, provider, model, api_key_enc, key_provider, system_prompt, min_unit_price_cents, max_unit_price_cents, max_items_per_job, max_quotes_per_day, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ownerId, input.name, input.description, input.provider, input.model, enc, enc ? input.provider : null, input.systemPrompt, input.minUnitPriceCents, input.maxUnitPriceCents, input.maxItemsPerJob, input.maxQuotesPerDay, input.status, ts, ts],
  );
  return getAgent(db, id)!;
}

function secretOrThrow(deps: AgentDeps): string {
  const s = secretOf(deps.env);
  if (!s) throw new AgentError("custody", "key custody is not configured on this server (AGENT_KEY_SECRET)");
  return s;
}

/** The seeded demo seller (dev provider) is exempt from the per-user platform-agent cap. */
function isSeedOwner(deps: AgentDeps, ownerId: string): boolean {
  const u = deps.db.query<{ provider: string }, [string]>("SELECT provider FROM users WHERE id = ?").get(ownerId);
  return u?.provider === "dev";
}

export async function updateAgent(deps: AgentDeps, ownerId: string, id: string, patch: AgentPatch): Promise<AgentRow> {
  const { db } = deps;
  const cur = getAgent(db, id);
  if (!cur) throw new AgentError("not_found", "agent not found");
  if (cur.owner_id !== ownerId) throw new AgentError("forbidden", "not your agent");
  const merged = applyPlatformLimits(AgentInput.parse({
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
  }));
  if (merged.provider === "platform" && cur.provider !== "platform") {
    const n = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM agents WHERE owner_id = ? AND provider = 'platform'").get(ownerId)!.n;
    if (n >= PLATFORM_AGENT_LIMITS.perUser && !isSeedOwner(deps, ownerId)) throw new AgentError("invalid", `at most ${PLATFORM_AGENT_LIMITS.perUser} platform-hosted agents per account`);
  }
  // Pacts between award and delivery run on this agent's current credential (frozen provider/model), so a
  // provider switch or key replacement while they are in flight would break them. Refuse until they finish.
  if ((merged.provider !== cur.provider || merged.apiKey) && cur.provider !== "platform") {
    const inFlight = inFlightPacts(db, id);
    if (inFlight) throw new AgentError("invalid", `${inFlight} pact${inFlight === 1 ? " is" : "s are"} still running on this agent's current key; wait for delivery before changing the provider or key`);
  }
  const enc = merged.apiKey ? await seal(merged.apiKey, secretOrThrow(deps)) : cur.api_key_enc;
  const keyProvider: AgentProvider | null = merged.apiKey ? merged.provider : cur.key_provider;
  if (merged.provider !== "platform" && !enc) throw new AgentError("invalid", "apiKey is required for a keyed provider");
  // A key is bound to the provider it was supplied for: switching provider needs a key for that provider.
  if (merged.provider !== "platform" && keyProvider !== merged.provider) throw new AgentError("invalid", `the stored key is for ${keyProvider}; supply an apiKey for ${merged.provider}`);
  db.run(
    `UPDATE agents SET name = ?, description = ?, provider = ?, model = ?, api_key_enc = ?, key_provider = ?, system_prompt = ?, min_unit_price_cents = ?, max_unit_price_cents = ?, max_items_per_job = ?, max_quotes_per_day = ?, status = ?, updated_at = ? WHERE id = ?`,
    [merged.name, merged.description, merged.provider, merged.model, enc, keyProvider, merged.systemPrompt, merged.minUnitPriceCents, merged.maxUnitPriceCents, merged.maxItemsPerJob, merged.maxQuotesPerDay, merged.status, now(), id],
  );
  return getAgent(db, id)!;
}

/** Awarded pacts that still need the seller's credential to produce the work (verification runs on the platform). */
export function inFlightPacts(db: Db, agentId: string): number {
  return db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM pacts WHERE agent_id = ? AND status IN ('AGREED','HELD')").get(agentId)!.n;
}

/** Remove the stored key. A keyed agent without a key is paused until a new key is supplied. */
export function deleteAgentKey(db: Db, ownerId: string, id: string): AgentRow {
  const cur = getAgent(db, id);
  if (!cur) throw new AgentError("not_found", "agent not found");
  if (cur.owner_id !== ownerId) throw new AgentError("forbidden", "not your agent");
  const inFlight = cur.provider !== "platform" ? inFlightPacts(db, id) : 0;
  if (inFlight) throw new AgentError("invalid", `${inFlight} pact${inFlight === 1 ? " is" : "s are"} still running on this key; wait for delivery before deleting it`);
  db.run("UPDATE agents SET api_key_enc = NULL, key_provider = NULL, status = CASE WHEN provider = 'platform' THEN status ELSE 'paused' END, updated_at = ? WHERE id = ?", [now(), id]);
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
/**
 * The LLM configuration an agent runs on. Decrypts the seller key only here. `frozen` (provider,
 * model) comes from the pact snapshot so a later edit to the agent cannot change what was purchased;
 * the credential is always the current one (custody can rotate it).
 */
export async function llmConfigForAgent(deps: AgentDeps, a: AgentRow, frozen?: { provider?: string; model?: string }): Promise<LlmConfig> {
  const provider = (frozen?.provider ?? a.provider) as AgentProvider;
  const model = frozen?.model ?? a.model;
  if (provider === "platform") return loadLlmConfig(deps.env);
  if (!a.api_key_enc) throw new AgentError("invalid", "agent has no API key");
  if (a.key_provider !== provider) throw new AgentError("invalid", `the agent's stored key is for ${a.key_provider ?? "no provider"}, the pact was frozen on ${provider}`);
  if (!modelAllowed(provider, model)) throw new AgentError("invalid", "model is not on the allowlist");
  const apiKey = await open(a.api_key_enc, secretOrThrow(deps));
  return { provider: provider as ProviderName, model, fastModel: model, apiKey };
}

/** Active and able to run: platform agents always; keyed agents only with a key bound to their provider. */
export function agentUsable(a: AgentRow | null | undefined): a is AgentRow {
  if (!a || a.status !== "active") return false;
  return a.provider === "platform" || (Boolean(a.api_key_enc) && a.key_provider === a.provider);
}

export function quotesTodayFor(db: Db, agentId: string): number {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  return db.query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM quotes WHERE agent_id = ? AND created_at > ?").get(agentId, since)!.n;
}

/** Seeded platform agents for the demo seller: three personas with different price bands so quotes compete. */
export const SEED_AGENTS: Array<Pick<AgentRow, "name" | "description" | "system_prompt" | "min_unit_price_cents" | "max_unit_price_cents">> = [
  {
    name: "Copywriter One",
    description: "Balanced store copy. Mentions every fact, keeps to the brief, mid-range price.",
    system_prompt: "Friendly, concrete, no hype. Lead with what the product is for, then the facts.",
    min_unit_price_cents: 50,
    max_unit_price_cents: 200,
  },
  {
    name: "Budget Scribe",
    description: "Fast and cheap. Terse descriptions that cover the facts and little else.",
    system_prompt: "Be brief and plain. Short sentences. Cover each fact once; no flourishes.",
    min_unit_price_cents: 30,
    max_unit_price_cents: 90,
  },
  {
    name: "Boutique Voice",
    description: "Premium tone for lifestyle brands. Slower, pricier, more evocative, still fact-exact.",
    system_prompt: "Evocative, sensory, editorial tone as in a design magazine, but never add a feature, material, number or claim that is not in the facts.",
    min_unit_price_cents: 120,
    max_unit_price_cents: 300,
  },
];

/** Idempotent (by name) seeded agents for the demo seller account. Returns the first one. */
export function ensureSeedAgent(db: Db, ownerId: string): AgentRow {
  let first: AgentRow | null = null;
  for (const seed of SEED_AGENTS) {
    const existing = db.query<AgentRow, [string, string]>("SELECT * FROM agents WHERE owner_id = ? AND name = ?").get(ownerId, seed.name);
    let row = existing;
    if (!row) {
      const id = crypto.randomUUID();
      const ts = now();
      db.run(
        `INSERT INTO agents (id, owner_id, name, description, provider, model, api_key_enc, system_prompt, min_unit_price_cents, max_unit_price_cents, max_items_per_job, max_quotes_per_day, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'platform', '', NULL, ?, ?, ?, 20, 100, 'active', ?, ?)`,
        [id, ownerId, seed.name, seed.description, seed.system_prompt, seed.min_unit_price_cents, seed.max_unit_price_cents, ts, ts],
      );
      row = getAgent(db, id)!;
    } else if (existing && existing.description !== seed.description) {
      db.run("UPDATE agents SET description = ?, system_prompt = ?, updated_at = ? WHERE id = ?", [seed.description, seed.system_prompt, now(), existing.id]);
      row = getAgent(db, existing.id)!;
    }
    first ??= row;
  }
  return first!;
}
