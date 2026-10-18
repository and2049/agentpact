import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { realAgents } from "./agents";
import { produceArtifact, quoteJob as llmQuote } from "./agents/seller";
import { cookieHeader, createSession, deleteSession, devLogin, parseCookies, SESSION_COOKIE, SESSION_TTL_MS, upsertUser, userForSession, userFromPayPal, type PayPalUserInfo, type User } from "./auth";
import { loadConfig } from "./config";
import { appendEvent, listEvents, now, openDb } from "./db";
import type { Scenario } from "./faults";
import { sampleJob } from "./jobs/sample";
import { loadLlmConfig, models } from "./llm";
import { ANY, createMandate, getMandate, MandateViolation, updateMandateCaps } from "./mandate";
import { AgentError, AgentInput, createAgent, deleteAgentKey, ensureSeedAgent, getAgent, listAgents, llmConfigForAgent, publicAgent, updateAgent, type AgentDeps } from "./market/agents";
import { awardJob, canSeeJobDetails, createJob, eligibleAgents, getJob, JobError, JobInput, jobSpecOf, listJobs, listQuotes, mandateForBuyer, publicJob, recordQuote, reopenJobFor, TEMPLATES } from "./market/jobs";
import { getPact, jobOf } from "./pact/machine";
import { preparePact } from "./pact/run";
import { TERMINAL, type Agents } from "./pact/stages";
import type { PactRow } from "./pact/types";
import { PayPalClient } from "./paypal/client";
import { completeCheckout } from "./payments/checkout";
import type { FlowDeps } from "./payments/flow";
import { listOps } from "./payments/ops";
import { authorizationForPact, captureForPact, payoutForPact } from "./payments/resources";
import { llmRubric } from "./verifier";
import { applyWebhook, type WebhookEvent } from "./webhooks";
import { enqueue, listTasks, withPactLock, Worker } from "./worker";

const config = loadConfig();
const db = openDb(config.dbPath);
const paypal = new PayPalClient({ base: config.paypalBase, clientId: config.clientId, clientSecret: config.clientSecret });
const env = process.env as Record<string, string | undefined>;

const BUYER_CARD = {
  number: "4012888888881881", // PayPal sandbox test card (demo mode only)
  expiry: "2030-12",
  name: "Buyer Agent",
  security_code: "123",
  billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
};
const flow: FlowDeps = { db, paypal, buyerCard: BUYER_CARD, sellerEmail: config.sellerEmail };
const agentDeps: AgentDeps = { db, env };

// ---------- seeded demo accounts (also the dev-login accounts) ----------
const demoBuyer = upsertUser(db, { provider: "dev", providerUserId: "buyer", name: "Demo Buyer", email: env.BUYER_SANDBOX_EMAIL || "buyer@dev.local" });
const demoSeller = upsertUser(db, { provider: "dev", providerUserId: "seller", name: "Demo Seller", email: config.sellerEmail || "seller@dev.local" });
const seedAgent = ensureSeedAgent(db, demoSeller.id);
const DEMO_MANDATE_ID = "default";
function demoMandate() {
  // Category stays pinned (the mandate check is part of the demo); the seller is open so the demo buyer can also award marketplace quotes.
  const m = getMandate(db, DEMO_MANDATE_ID) ?? createMandate(db, { id: DEMO_MANDATE_ID, maxPerPactCents: 5000, maxAggregateCents: 50_000, allowedCategory: "product_descriptions", allowedSeller: ANY, ownerId: demoBuyer.id });
  if (!m.owner_id || m.allowed_seller !== ANY) db.run("UPDATE mandates SET owner_id = ?, allowed_seller = ? WHERE id = ?", [demoBuyer.id, ANY, m.id]);
  return getMandate(db, DEMO_MANDATE_ID)!;
}
demoMandate();

// ---------- agents per pact ----------
function agentsFor(pact: PactRow): Agents {
  if (pact.kind === "demo" || !pact.agent_id) return realAgents(loadLlmConfig(env), pact.id).agents;
  const row = getAgent(db, pact.agent_id);
  const frozen = pact.frozen_json ? (JSON.parse(pact.frozen_json) as { agent?: { system_prompt?: string } }) : {};
  const platform = realAgents(loadLlmConfig(env), pact.id).agents;
  return {
    quote: platform.quote,
    decide: platform.decide,
    produce: async (job, onBatch) => {
      if (!row) throw new Error("agent no longer exists");
      const cfg = await llmConfigForAgent(agentDeps, row);
      return produceArtifact(job, models(cfg, pact.id).main, { batchSize: 5, concurrency: 4, onBatch, sellerPrompt: frozen.agent?.system_prompt ?? row.system_prompt });
    },
    rubric: llmRubric(models(loadLlmConfig(env), pact.id).fast), // the verifier always runs on the platform's configuration
  };
}

/** Quote an open job from every eligible agent (bounded). LLM failures fall back to a deterministic quote. */
async function quoteOpenJob(jobId: string) {
  const job = getJob(db, jobId);
  if (!job || job.status !== "OPEN") return;
  for (const agent of eligibleAgents(db, job)) {
    const spec = jobSpecOf(job, "");
    const items = spec.skus.length;
    let q: { unitPriceCents: number; etaMinutes: number; message: string };
    try {
      const cfg = await llmConfigForAgent(agentDeps, agent);
      q = await llmQuote(spec, models(cfg, `quote-${job.id}-${agent.id}`).main);
    } catch (e) {
      q = { unitPriceCents: Math.round((agent.min_unit_price_cents + Math.min(agent.max_unit_price_cents, job.max_unit_price_cents)) / 2), etaMinutes: Math.max(2, items), message: `Automated quote from ${agent.name}: ${items} items, paid per accepted item.` };
      console.error(`quote via LLM failed for agent ${agent.id}: ${(e as Error).message}`);
    }
    recordQuote(db, job, agent, q);
  }
}

const worker = new Worker(db, { flow, agentsFor, pollMs: 3000, quoteJob: quoteOpenJob, onTerminal: (p) => reopenJobFor(db, p) });
const recovered = worker.recover();
if (recovered.requeued || recovered.pacts.length) console.log(`worker: recovered ${recovered.requeued} task(s), ${recovered.pacts.length} pact(s) re-queued`);
worker.start();

// ---------- helpers ----------
type Ctx = Context;
const bad = (status: 400 | 401 | 403 | 404 | 409 | 422 | 503, message: string, extra: Record<string, unknown> = {}) =>
  new HTTPException(status, { res: new Response(JSON.stringify({ error: message, ...extra }), { status, headers: { "Content-Type": "application/json" } }) });

function currentUser(c: Ctx): User | null {
  return userForSession(db, parseCookies(c.req.header("cookie"))[SESSION_COOKIE]);
}
function requireUser(c: Ctx): User {
  const u = currentUser(c);
  if (!u) throw bad(401, "login required", { login: "/auth/paypal/start" });
  return u;
}
function canSeePact(user: User | null, pact: PactRow): boolean {
  if (pact.kind === "demo") return true;
  return Boolean(user && (pact.buyer_id === user.id || pact.seller_id === user.id));
}
function requirePactView(c: Ctx, id: string): { pact: PactRow; user: User | null } {
  const pact = getPact(db, id);
  if (!pact) throw bad(404, "not found");
  const user = currentUser(c);
  if (!canSeePact(user, pact)) throw bad(user ? 403 : 401, "not your pact");
  return { pact, user };
}
function publicOrigin(c: Ctx): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, "");
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? u.host;
  return `${proto}://${host}`;
}
async function body<T extends z.ZodTypeAny>(c: Ctx, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => null);
  const r = schema.safeParse(raw);
  if (!r.success) throw bad(400, "invalid body", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}
function userName(id: string | null): string {
  if (!id) return "";
  return db.query<{ name: string }, [string]>("SELECT name FROM users WHERE id = ?").get(id)?.name ?? "";
}

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof JobError) return c.json({ error: err.message, code: err.code }, err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : err.code === "state" ? 409 : 400);
  if (err instanceof AgentError) return c.json({ error: err.message, code: err.code }, err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : err.code === "custody" ? 503 : 400);
  if (err instanceof MandateViolation) return c.json({ error: err.message, code: err.code }, 409);
  if (err instanceof z.ZodError) return c.json({ error: "invalid body", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true, env: config.paypalEnv }));

/** Browser-safe configuration for the thin client. */
app.get("/api/config", (c) => c.json({ clientId: config.clientId, env: config.paypalEnv, devLogin: Boolean(env.DEV_LOGIN_PASSCODE), keyCustody: Boolean(env.AGENT_KEY_SECRET), templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name, rubric: t.rubric })) }));
app.get("/api/paypal/client-config", (c) => c.json({ clientId: config.clientId, env: config.paypalEnv }));

// ---------- identity ----------
const LIPP_SCOPES = "openid profile email";
app.get("/auth/paypal/start", (c) => {
  const origin = publicOrigin(c);
  const state = crypto.randomUUID();
  const u = new URL("https://www.sandbox.paypal.com/connect");
  u.searchParams.set("flowEntry", "static");
  u.searchParams.set("client_id", config.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", LIPP_SCOPES);
  u.searchParams.set("redirect_uri", `${origin}/auth/paypal/callback`);
  u.searchParams.set("state", state);
  c.header("Set-Cookie", `lipp_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${origin.startsWith("https") ? "; Secure" : ""}`);
  return c.redirect(u.toString());
});

app.get("/auth/paypal/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookies = parseCookies(c.req.header("cookie"));
  if (!code) return c.json({ error: "no code", query: c.req.query() }, 400);
  if (!state || state !== cookies.lipp_state) return c.json({ error: "state mismatch" }, 400);
  const tokenRes = await fetch(`${config.paypalBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${config.clientId}:${config.clientSecret}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
  });
  const token = (await tokenRes.json()) as { access_token?: string; scope?: string; error_description?: string };
  if (!token.access_token) return c.json({ step: "token", status: tokenRes.status, error: token.error_description ?? token }, 502);
  const infoRes = await fetch(`${config.paypalBase}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  const info = (await infoRes.json()) as PayPalUserInfo;
  console.log(`lipp userinfo ${infoRes.status} scope=${token.scope} keys=${Object.keys(info).join(",")}`);
  const mapped = userFromPayPal(info);
  if (!mapped) return c.json({ step: "userinfo", status: infoRes.status, error: "user_id or email missing", keys: Object.keys(info) }, 502);
  const user = upsertUser(db, { provider: "paypal", ...mapped });
  const session = createSession(db, user.id);
  const secure = publicOrigin(c).startsWith("https");
  c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, session.id, { maxAge: SESSION_TTL_MS / 1000, secure }), { append: true });
  c.header("Set-Cookie", "lipp_state=; Path=/; Max-Age=0", { append: true });
  return c.redirect("/#/me");
});

/** Passcode-gated seeded accounts (fallback when Log in with PayPal is unavailable). */
app.post("/auth/dev", async (c) => {
  const b = await body(c, z.object({ passcode: z.string().default(""), who: z.string().default("") }));
  const user = devLogin(db, { passcode: b.passcode, who: b.who, env });
  if (!user) return c.json({ error: "dev login disabled or invalid" }, 403);
  const session = createSession(db, user.id);
  c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, session.id, { maxAge: SESSION_TTL_MS / 1000, secure: publicOrigin(c).startsWith("https") }));
  return c.json({ user });
});

app.get("/me", (c) => {
  const user = currentUser(c);
  if (!user) return c.json({ user: null, login: "/auth/paypal/start" }, 401);
  return c.json({ user });
});

app.post("/logout", (c) => {
  deleteSession(db, parseCookies(c.req.header("cookie"))[SESSION_COOKIE]);
  c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, "", { maxAge: 0, secure: false }));
  return c.json({ ok: true });
});

/** Role-aware account page: holds, spend, mandate, agents, earnings. */
app.get("/api/me", (c) => {
  const user = requireUser(c);
  const mandate = mandateForBuyer(db, user.id);
  const asBuyer = db.query<PactRow, [string]>("SELECT * FROM pacts WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 100").all(user.id);
  const asSeller = db.query<PactRow, [string]>("SELECT * FROM pacts WHERE seller_id = ? AND kind = 'market' ORDER BY created_at DESC LIMIT 100").all(user.id);
  const earned = asSeller.filter((p) => p.status === "PAID_OUT").reduce((s, p) => s + (p.charge_cents ?? 0), 0);
  return c.json({
    user,
    mandate,
    jobs: listJobs(db, { buyerId: user.id }).map((j) => publicJob(db, j)),
    agents: listAgents(db, { ownerId: user.id }).map((a) => publicAgent(db, a, user.id)),
    pacts: { asBuyer: asBuyer.map(pactSummary), asSeller: asSeller.map(pactSummary) },
    earnedCents: earned,
  });
});

app.put("/api/mandate", async (c) => {
  const user = requireUser(c);
  const b = await body(c, z.object({ maxPerPactCents: z.number().int().min(100).max(100_000), maxAggregateCents: z.number().int().min(100).max(1_000_000) }));
  const m = mandateForBuyer(db, user.id);
  return c.json(updateMandateCaps(db, m.id, b));
});
app.get("/api/mandate", (c) => {
  const user = currentUser(c);
  return c.json(user ? mandateForBuyer(db, user.id) : demoMandate());
});

// ---------- agents ----------
app.get("/api/agents", (c) => {
  const user = currentUser(c);
  return c.json(listAgents(db, { activeOnly: !c.req.query("all") }).map((a) => publicAgent(db, a, user?.id)));
});
app.post("/api/agents", async (c) => {
  const user = requireUser(c);
  const input = await body(c, AgentInput);
  return c.json(publicAgent(db, await createAgent(agentDeps, user.id, input), user.id), 201);
});
app.get("/api/agents/:id", (c) => {
  const a = getAgent(db, c.req.param("id"));
  if (!a) throw bad(404, "not found");
  return c.json(publicAgent(db, a, currentUser(c)?.id));
});
app.patch("/api/agents/:id", async (c) => {
  const user = requireUser(c);
  const patch = await body(c, AgentInput.partial());
  return c.json(publicAgent(db, await updateAgent(agentDeps, user.id, c.req.param("id"), patch as Partial<AgentInput>), user.id));
});
app.delete("/api/agents/:id/key", (c) => {
  const user = requireUser(c);
  return c.json(publicAgent(db, deleteAgentKey(db, user.id, c.req.param("id")), user.id));
});

// ---------- jobs & quotes ----------
app.get("/api/jobs", (c) => {
  const status = (c.req.query("status") ?? "open").toUpperCase();
  const rows = listJobs(db, { status: ["OPEN", "AWARDED", "CLOSED"].includes(status) ? (status as "OPEN") : undefined });
  return c.json(rows.map((j) => publicJob(db, j)));
});
app.post("/api/jobs", async (c) => {
  const user = requireUser(c);
  const input = await body(c, JobInput);
  const job = createJob(db, user.id, input);
  enqueue(db, job.id, "quote_job");
  return c.json({ ...publicJob(db, job), items: input.items, rubric: JSON.parse(job.rubric_json), quotes: [] }, 201);
});
app.get("/api/jobs/:id", (c) => {
  const job = getJob(db, c.req.param("id"));
  if (!job) throw bad(404, "not found");
  const user = currentUser(c);
  const base = { ...publicJob(db, job), buyer_id: job.buyer_id, pact_id: job.pact_id, mine: user?.id === job.buyer_id };
  if (!canSeeJobDetails(db, job, user?.id)) return c.json({ ...base, restricted: true });
  const quotes = listQuotes(db, job.id).map((q) => {
    const a = getAgent(db, q.agent_id);
    return { ...q, agent: a ? publicAgent(db, a, null) : null, seller_name: userName(q.seller_id) };
  });
  return c.json({ ...base, items: JSON.parse(job.items_json), rubric: JSON.parse(job.rubric_json), quotes, quoting: listTasks(db, job.id).some((t) => t.kind === "quote_job" && (t.status === "queued" || t.status === "running")) });
});
app.get("/api/jobs/:id/quotes", (c) => {
  const job = getJob(db, c.req.param("id"));
  if (!job) throw bad(404, "not found");
  const user = currentUser(c);
  if (!canSeeJobDetails(db, job, user?.id)) throw bad(user ? 403 : 401, "not your job");
  return c.json(listQuotes(db, job.id));
});
/** Award a quote: frozen pact + approval order. Returns the pact and order ids for the PayPal button. */
app.post("/api/jobs/:id/award", async (c) => {
  const user = requireUser(c);
  const b = await body(c, z.object({ quoteId: z.string().min(1) }));
  const r = await awardJob({ db, flow }, { jobId: c.req.param("id"), quoteId: b.quoteId, buyerId: user.id });
  if (r.pact.status !== "AGREED") reopenJobFor(db, r.pact);
  return c.json({ pactId: r.pact.id, orderId: r.pact.order_id, status: r.pact.status, checkout: r.checkout.ok ? "ready" : r.checkout.code, message: r.checkout.ok ? "" : r.checkout.message }, r.checkout.ok ? 201 : 409);
});

// ---------- pacts ----------
function pactSummary(p: PactRow) {
  return {
    id: p.id,
    kind: p.kind,
    scenario: p.scenario,
    status: p.status,
    title: jobOf(p).title,
    item_count: p.item_count,
    unit_price_cents: p.unit_price_cents,
    authorized_cents: p.authorized_cents,
    accepted_count: p.accepted_count,
    charge_cents: p.charge_cents,
    settlement_kind: p.settlement_kind,
    job_id: p.job_id,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

app.get("/api/pacts", (c) => {
  const user = currentUser(c);
  const rows = user
    ? db.query<PactRow, [string, string]>("SELECT * FROM pacts WHERE kind = 'demo' OR buyer_id = ? OR seller_id = ? ORDER BY created_at DESC LIMIT 100").all(user.id, user.id)
    : db.query<PactRow, []>("SELECT * FROM pacts WHERE kind = 'demo' ORDER BY created_at DESC LIMIT 100").all();
  return c.json(rows.map(pactSummary));
});

app.get("/api/pacts/:id", (c) => {
  const { pact, user } = requirePactView(c, c.req.param("id"));
  const items = db.query<{ sku: string; verdict: string; reason: string; score: number | null; evidence_json: string }, [string]>("SELECT * FROM item_verdicts WHERE pact_id = ?").all(pact.id);
  const artifact = db.query<{ body_json: string }, [string]>("SELECT body_json FROM artifacts WHERE pact_id = ?").get(pact.id);
  const agent = pact.agent_id ? getAgent(db, pact.agent_id) : null;
  return c.json({
    pact: { ...pact, frozen: pact.frozen_json ? JSON.parse(pact.frozen_json) : null, frozen_json: undefined, buyer_name: userName(pact.buyer_id), seller_name: userName(pact.seller_id) },
    job: jobOf(pact),
    agent: agent ? publicAgent(db, agent, null) : null,
    viewer: user ? { id: user.id, role: pact.buyer_id === user.id ? "buyer" : pact.seller_id === user.id ? "seller" : "viewer" } : null,
    can_approve: Boolean(user && pact.kind === "market" && pact.buyer_id === user.id && pact.status === "AGREED" && pact.order_id),
    authorization: authorizationForPact(db, pact.id),
    capture: captureForPact(db, pact.id),
    payout: payoutForPact(db, pact.id),
    items: items.map((i) => ({ ...i, evidence: JSON.parse(i.evidence_json) })),
    artifact: artifact ? JSON.parse(artifact.body_json) : null,
    ops: listOps(db, pact.id),
    events: listEvents(db, pact.id),
    tasks: listTasks(db, pact.id),
  });
});

/** Event stream for one pact: replays history, then tails new events. */
app.get("/api/pacts/:id/events", (c) => {
  const { pact } = requirePactView(c, c.req.param("id"));
  const id = pact.id;
  return streamSSE(c, async (stream) => {
    let last = Number(c.req.query("after") ?? 0);
    while (!stream.closed) {
      for (const e of listEvents(db, id, last)) {
        last = e.seq;
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: e.payload_json });
        if (e.type === "run.finished" || e.type === "pact.rejected") return;
      }
      await stream.sleep(400);
    }
  });
});

/** Buyer approved in PayPal: verify ownership and the order, authorize, HELD, then start the work. */
app.post("/api/pacts/:id/approve", async (c) => {
  const user = requireUser(c);
  const b = await body(c, z.object({ orderId: z.string().min(1) }));
  const id = c.req.param("id");
  const pact = getPact(db, id);
  if (!pact) throw bad(404, "not found");
  if (pact.kind !== "market" || pact.buyer_id !== user.id) throw bad(403, "not your pact");
  const r = await withPactLock(id, () => completeCheckout(flow, id, b.orderId));
  if (r.ok && r.pact.status === "HELD") {
    say(id, "platform", `Authorization recorded for ${r.pact.authorized_cents}¢. The seller agent starts now.`);
    enqueue(db, id, "advance");
  } else if (!r.ok && r.pact && TERMINAL.includes(r.pact.status)) reopenJobFor(db, r.pact);
  return c.json(r.ok ? { ok: true, status: r.pact.status } : { ok: false, code: r.code, error: r.message, status: r.pact?.status ?? null }, r.ok ? 200 : r.code === "not_approved" || r.code === "unknown" ? 409 : 422);
});
function say(pactId: string, role: "buyer" | "seller" | "verifier" | "platform", text: string) {
  appendEvent(db, pactId, "agent.message", { role, text });
}

// ---------- demo mode: seeded buyer + seeded agent through the same stages ----------
function activeDemoRun(): string | null {
  const row = db
    .query<{ subject_id: string }, []>("SELECT t.subject_id FROM tasks t JOIN pacts p ON p.id = t.subject_id WHERE t.kind = 'advance' AND t.status IN ('queued','running') AND p.kind = 'demo' LIMIT 1")
    .get();
  return row?.subject_id ?? null;
}
app.post("/api/demo/runs", async (c) => {
  const b = await body(c, z.object({ scenario: z.enum(["good", "partial", "broken"]).default("good") }));
  const active = activeDemoRun();
  if (active) return c.json({ error: "a demo run is already in progress", pactId: active }, 409);
  try {
    loadLlmConfig(env);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 503);
  }
  const m = demoMandate();
  const job = sampleJob(config.sellerEmail);
  const pact = preparePact(db, { mandateId: m.id, job, scenario: b.scenario as Scenario, buyerId: demoBuyer.id, sellerId: demoSeller.id });
  // A matching job row so demo runs appear under the demo buyer's jobs and the pact page can link to them.
  const row = createJob(db, demoBuyer.id, { template: "product_descriptions", title: job.title, brief: job.brief, items: job.skus, maxUnitPriceCents: job.maxUnitPriceCents, minWords: job.rubric.minWords, maxWords: job.rubric.maxWords });
  db.run("UPDATE jobs SET status = 'AWARDED', pact_id = ?, updated_at = ? WHERE id = ?", [pact.id, now(), row.id]);
  db.run("UPDATE pacts SET agent_id = ?, job_id = ? WHERE id = ?", [seedAgent.id, row.id, pact.id]);
  enqueue(db, pact.id, "advance");
  return c.json({ pactId: pact.id, scenario: b.scenario }, 202);
});
app.post("/api/runs", (c) => c.redirect("/api/demo/runs", 307));
app.get("/api/demo/active", (c) => c.json({ pactId: activeDemoRun() }));

// ---------- PayPal webhook receiver (rejects unverifiable events) ----------
app.post("/api/paypal/webhook", async (c) => {
  const raw = await c.req.text();
  if (!config.webhookId) return c.json({ error: "webhook id not configured" }, 503);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  let ok = false;
  try {
    ok = await paypal.verifyWebhookSignature({ webhookId: config.webhookId, headers, body: raw });
  } catch (e) {
    return c.json({ error: `verification failed: ${(e as Error).message}` }, 400);
  }
  if (!ok) return c.json({ error: "invalid signature" }, 400);
  const ev = JSON.parse(raw) as WebhookEvent;
  const pactId = typeof ev.resource?.custom_id === "string" ? ev.resource.custom_id : String((ev.resource as { payout_item?: { sender_item_id?: string } })?.payout_item?.sender_item_id ?? "").split(":")[0];
  const result = pactId ? await withPactLock(pactId, () => applyWebhook(flow, ev)) : await applyWebhook(flow, ev);
  if (pactId && getPact(db, pactId)) enqueue(db, pactId, "advance"); // let the worker promote state promptly
  return c.json({ ok: true, result });
});

app.use("/*", serveStatic({ root: "./public" }));

export default { port: config.port, fetch: app.fetch, idleTimeout: 120 };
