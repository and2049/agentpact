/**
 * Provider-agnostic LLM access. One env switch picks the provider; agents and
 * the verifier only ever see `LanguageModel` instances from `models()`.
 *
 *   LLM_PROVIDER = opencode | anthropic | openai | openai-compatible
 *   LLM_MODEL        main model (buyer, seller)
 *   LLM_MODEL_FAST   cheap model (per-item verifier rubric); defaults to LLM_MODEL
 *
 * OpenCode Go routes by model family: claude-* goes through its Anthropic
 * Messages endpoint, gpt-* / grok-* / muse-spark-* through the OpenAI Responses
 * endpoint, everything else through OpenAI Chat Completions. Go also requires
 * a stable `x-opencode-session` header per conversation (routing + prompt
 * caching) and asks clients to send their own User-Agent.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type ProviderName = "opencode" | "anthropic" | "openai" | "openai-compatible";

export interface LlmConfig {
  provider: ProviderName;
  model: string;
  fastModel: string;
  apiKey: string;
  baseUrl?: string;
}

const OPENCODE_GO = "https://opencode.ai/inference/go";

const DEFAULT_MODEL: Record<ProviderName, { model: string; fast: string }> = {
  opencode: { model: "glm-5.3", fast: "glm-5.3-flash" },
  anthropic: { model: "claude-sonnet-5-5", fast: "claude-haiku-5-5" },
  openai: { model: "gpt-5.5", fast: "gpt-5.5-mini" },
  "openai-compatible": { model: "", fast: "" },
};

export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const explicit = env.LLM_PROVIDER as ProviderName | undefined;
  const provider: ProviderName =
    explicit ?? (env.OPENCODE_API_KEY ? "opencode" : env.ANTHROPIC_API_KEY ? "anthropic" : env.OPENAI_API_KEY ? "openai" : "openai-compatible");
  const keyByProvider: Record<ProviderName, string | undefined> = {
    opencode: env.OPENCODE_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    "openai-compatible": env.LLM_API_KEY,
  };
  const apiKey = env.LLM_API_KEY && provider !== "openai-compatible" ? (keyByProvider[provider] ?? env.LLM_API_KEY) : (keyByProvider[provider] ?? "");
  const model = env.LLM_MODEL || DEFAULT_MODEL[provider].model;
  const fastModel = env.LLM_MODEL_FAST || DEFAULT_MODEL[provider].fast || model;
  if (!apiKey) throw new Error(`no API key for LLM provider "${provider}" (set OPENCODE_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / LLM_API_KEY)`);
  if (!model) throw new Error(`LLM_MODEL is required for provider "${provider}"`);
  return { provider, model, fastModel, apiKey, baseUrl: env.LLM_BASE_URL || undefined };
}

/**
 * A model plus an optional fallback that avoids native JSON-schema output.
 * Some gateways (OpenCode Go for DeepSeek) intermittently reject
 * `response_format: json_schema`; the fallback uses prompt-guided JSON instead.
 */
export interface ModelSlot {
  model: LanguageModel;
  fallback: LanguageModel | null;
}

export interface Models {
  main: ModelSlot;
  fast: ModelSlot;
  describe: string;
}

function isStructuredOutputRejection(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  const status = (e as { statusCode?: number })?.statusCode;
  return status === 400 && /response_format|json_schema|structured/i.test(msg);
}

function isMalformedObject(e: unknown): boolean {
  const name = String((e as Error)?.name ?? "");
  // NoOutputGenerated: the model spent the whole output budget on reasoning and returned no text.
  return /NoObjectGenerated|NoOutputGenerated|TypeValidation|JSONParse/i.test(name);
}

/**
 * Run `fn` on the slot's model. On a structured-output rejection by the
 * gateway, switch to the fallback model. On a malformed object (schema
 * mismatch, bad JSON, or no output because reasoning ate the budget) retry once on whichever model was
 * in use, passing `attempt = 1` so the caller can widen `maxOutputTokens`.
 */
export async function withFallback<T>(slot: ModelSlot, fn: (m: LanguageModel, attempt: number) => Promise<T>): Promise<T> {
  let model = slot.model;
  let retried = false;
  for (;;) {
    try {
      return await fn(model, retried ? 1 : 0); // callers may widen the output budget on the retry
    } catch (e) {
      if (slot.fallback && model !== slot.fallback && isStructuredOutputRejection(e)) {
        model = slot.fallback;
        continue;
      }
      if (!retried && isMalformedObject(e)) {
        retried = true;
        continue;
      }
      throw e;
    }
  }
}

const USER_AGENT = "agentpact/0.1";

/**
 * Build the two models. `sessionId` should be stable for one conversation
 * (e.g. one pact); it is only used by providers that route on it.
 */
export function models(cfg: LlmConfig = loadLlmConfig(), sessionId: string = crypto.randomUUID()): Models {
  const headers = { "x-opencode-session": sessionId, "User-Agent": USER_AGENT };
  const make = (id: string, nativeJson = true): LanguageModel => {
    switch (cfg.provider) {
      case "anthropic":
        return createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })(id);
      case "openai":
        return createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })(id);
      case "openai-compatible": {
        if (!cfg.baseUrl) throw new Error("LLM_BASE_URL is required for provider openai-compatible");
        return createOpenAICompatible({ name: "custom", apiKey: cfg.apiKey, baseURL: cfg.baseUrl }).chatModel(id);
      }
      case "opencode": {
        const base = cfg.baseUrl ?? OPENCODE_GO;
        if (id.startsWith("claude-")) return createAnthropic({ apiKey: cfg.apiKey, baseURL: `${base}/anthropic/v1`, headers })(id);
        if (/^(gpt-|grok-|muse-spark-)/.test(id)) return createOpenAI({ apiKey: cfg.apiKey, baseURL: `${base}/openai/v1`, headers }).responses(id);
        return createOpenAICompatible({ name: "opencode-go", apiKey: cfg.apiKey, baseURL: `${base}/openai/v1`, headers, supportsStructuredOutputs: nativeJson }).chatModel(id);
      }
    }
  };
  const slot = (id: string): ModelSlot => {
    const usesChatCompletions = cfg.provider === "opencode" && !id.startsWith("claude-") && !/^(gpt-|grok-|muse-spark-)/.test(id);
    return { model: make(id), fallback: usesChatCompletions ? make(id, false) : null };
  };
  return { main: slot(cfg.model), fast: slot(cfg.fastModel), describe: `${cfg.provider}: ${cfg.model} (fast: ${cfg.fastModel})` };
}
