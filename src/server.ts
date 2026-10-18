import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { realAgents } from "./agents";
import { loadConfig } from "./config";
import { appendEvent, listEvents, openDb } from "./db";
import type { Scenario } from "./faults";
import { sampleJob } from "./jobs/sample";
import { loadLlmConfig } from "./llm";
import { createMandate, getMandate } from "./mandate";
import { getPact, listPacts } from "./pact/machine";
import { preparePact, runPact } from "./pact/run";
import { PayPalClient } from "./paypal/client";
import type { FlowDeps } from "./payments/flow";
import { listOps } from "./payments/ops";
import { authorizationForPact, captureForPact, payoutForPact } from "./payments/resources";
import { applyWebhook, type WebhookEvent } from "./webhooks";

const config = loadConfig();
const db = openDb(config.dbPath);
const paypal = new PayPalClient({ base: config.paypalBase, clientId: config.clientId, clientSecret: config.clientSecret });

const BUYER_CARD = {
  number: "4012888888881881", // PayPal sandbox test card
  expiry: "2030-12",
  name: "Buyer Agent",
  security_code: "123",
  billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
};
const flow: FlowDeps = { db, paypal, buyerCard: BUYER_CARD, sellerEmail: config.sellerEmail };

const MANDATE_ID = "default";
function mandate() {
  return (
    getMandate(db, MANDATE_ID) ??
    createMandate(db, { id: MANDATE_ID, maxPerPactCents: 5000, maxAggregateCents: 50_000, allowedCategory: "product_descriptions", allowedSeller: config.sellerEmail })
  );
}

let activeRun: string | null = null;

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, env: config.paypalEnv, activeRun }));

app.get("/api/mandate", (c) => c.json(mandate()));

app.get("/api/pacts", (c) => c.json(listPacts(db)));

app.get("/api/pacts/:id", (c) => {
  const pact = getPact(db, c.req.param("id"));
  if (!pact) return c.json({ error: "not found" }, 404);
  const items = db.query<{ sku: string; verdict: string; reason: string; score: number | null; evidence_json: string }, [string]>("SELECT * FROM item_verdicts WHERE pact_id = ?").all(pact.id);
  const artifact = db.query<{ body_json: string }, [string]>("SELECT body_json FROM artifacts WHERE pact_id = ?").get(pact.id);
  return c.json({
    pact,
    job: JSON.parse(pact.job_json),
    authorization: authorizationForPact(db, pact.id),
    capture: captureForPact(db, pact.id),
    payout: payoutForPact(db, pact.id),
    items: items.map((i) => ({ ...i, evidence: JSON.parse(i.evidence_json) })),
    artifact: artifact ? JSON.parse(artifact.body_json) : null,
    ops: listOps(db, pact.id),
    events: listEvents(db, pact.id),
  });
});

/** Event stream for one pact: replays history, then tails new events. */
app.get("/api/pacts/:id/events", (c) => {
  const id = c.req.param("id");
  if (!getPact(db, id)) return c.json({ error: "not found" }, 404);
  return streamSSE(c, async (stream) => {
    let last = 0;
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

/** Start a run. Returns the pact id immediately; the run continues in the background. */
app.post("/api/runs", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { scenario?: string };
  const scenario = (["good", "partial", "broken"].includes(body.scenario ?? "") ? body.scenario : "good") as Scenario;
  if (activeRun) return c.json({ error: "a run is already in progress", pactId: activeRun }, 409);
  let llm: ReturnType<typeof loadLlmConfig>;
  try {
    llm = loadLlmConfig();
  } catch (e) {
    return c.json({ error: (e as Error).message }, 503);
  }
  const m = mandate();
  const job = sampleJob(config.sellerEmail);
  const pact = preparePact(db, { mandateId: m.id, job, scenario });
  activeRun = pact.id;
  const { agents } = realAgents(llm, pact.id);
  runPact({ flow, agents }, { mandateId: m.id, job, scenario, pactId: pact.id })
    .catch((e) => {
      appendEvent(db, pact.id, "run.error", { message: String((e as Error).message).slice(0, 500) });
      appendEvent(db, pact.id, "run.finished", { status: "error" });
    })
    .finally(() => {
      if (activeRun === pact.id) activeRun = null;
    });
  return c.json({ pactId: pact.id, scenario }, 202);
});

/** PayPal webhook receiver. Rejects unverifiable events. */
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
  const result = await applyWebhook(flow, ev);
  return c.json({ ok: true, result });
});

// ---------- Spike (a): Checkout approval -> server authorize ----------
app.get("/api/paypal/client-config", (c) => c.json({ clientId: config.clientId, env: config.paypalEnv }));

app.post("/spike/orders", async (c) => {
  try {
    const order = await paypal.createApprovalOrder({ requestId: crypto.randomUUID(), amountCents: 1234, customId: "spike-checkout", referenceId: "spike" });
    appendSpike("order.created", { orderId: order.id, status: order.status });
    return c.json({ orderId: order.id, status: order.status });
  } catch (e) {
    return c.json({ error: (e as Error).message, body: (e as { body?: unknown }).body ?? null }, 500);
  }
});

app.post("/spike/authorize", async (c) => {
  const { orderId } = (await c.req.json().catch(() => ({}))) as { orderId?: string };
  if (!orderId) return c.json({ error: "orderId required" }, 400);
  try {
    const before = await paypal.getOrder(orderId);
    const order = await paypal.authorizeOrder({ requestId: crypto.randomUUID(), orderId });
    const auth = order.purchase_units[0]?.payments?.authorizations?.[0] ?? null;
    appendSpike("order.authorized", { orderId, statusBefore: before.status, statusAfter: order.status, authorization: auth });
    return c.json({ pass: auth?.status === "CREATED", orderStatusBefore: before.status, orderStatusAfter: order.status, authorization: auth });
  } catch (e) {
    return c.json({ pass: false, error: (e as Error).message, body: (e as { body?: unknown }).body ?? null }, 500);
  }
});

// ---------- Spike (b): Log in with PayPal ----------
const LIPP_SCOPES = "openid profile email";
app.get("/auth/paypal/start", (c) => {
  const origin = new URL(c.req.url).origin;
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
  const cookie = (c.req.header("cookie") ?? "").match(/(?:^|;\s*)lipp_state=([^;]+)/)?.[1];
  if (!code) return c.json({ pass: false, error: "no code", query: c.req.query() }, 400);
  if (!state || state !== cookie) return c.json({ pass: false, error: "state mismatch", state, cookie: Boolean(cookie) }, 400);
  const tokenRes = await fetch(`${config.paypalBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${config.clientId}:${config.clientSecret}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
  });
  const token = (await tokenRes.json()) as { access_token?: string; scope?: string; error_description?: string };
  if (!token.access_token) return c.json({ pass: false, step: "token", status: tokenRes.status, error: token.error_description ?? token }, 502);
  const infoRes = await fetch(`${config.paypalBase}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  const info = (await infoRes.json()) as Record<string, unknown>;
  appendSpike("lipp.userinfo", { status: infoRes.status, scope: token.scope, keys: Object.keys(info) });
  const emails = (info.emails as Array<{ value: string; primary?: boolean }> | undefined) ?? [];
  return c.json({ pass: Boolean(info.user_id) && emails.length > 0, scope: token.scope, userinfo: info });
});

function appendSpike(type: string, payload: unknown) {
  db.run("INSERT INTO events (pact_id, type, payload_json, created_at) VALUES ('spike', ?, ?, ?)", [type, JSON.stringify(payload), new Date().toISOString()]);
}
app.get("/spike/log", (c) => c.json(listEvents(db, "spike")));

app.use("/*", serveStatic({ root: "./public" }));

export default { port: config.port, fetch: app.fetch, idleTimeout: 120 };
