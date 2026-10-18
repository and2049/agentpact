import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { loadConfig } from "./config";
import { listEvents, openDb } from "./db";
import { getPact, listPacts } from "./pact/machine";
import { PayPalClient } from "./paypal/client";
import { listOps } from "./payments/ops";
import { authorizationForPact, captureForPact, payoutForPact } from "./payments/resources";

const config = loadConfig();
const db = openDb(config.dbPath);
export const paypal = new PayPalClient({ base: config.paypalBase, clientId: config.clientId, clientSecret: config.clientSecret });

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, env: config.paypalEnv }));

app.get("/api/pacts", (c) => c.json(listPacts(db)));

app.get("/api/pacts/:id", (c) => {
  const pact = getPact(db, c.req.param("id"));
  if (!pact) return c.json({ error: "not found" }, 404);
  return c.json({
    pact,
    authorization: authorizationForPact(db, pact.id),
    capture: captureForPact(db, pact.id),
    payout: payoutForPact(db, pact.id),
    ops: listOps(db, pact.id),
    events: listEvents(db, pact.id),
  });
});

/** Event stream for one pact: replays history, then tails new events by polling the DB. */
app.get("/api/pacts/:id/events", (c) => {
  const id = c.req.param("id");
  if (!getPact(db, id)) return c.json({ error: "not found" }, 404);
  return streamSSE(c, async (stream) => {
    let last = 0;
    while (!stream.closed) {
      for (const e of listEvents(db, id, last)) {
        last = e.seq;
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: e.payload_json });
      }
      await stream.sleep(500);
    }
  });
});

app.get("/", (c) => c.text("AgentPact scaffold. See /health and /api/pacts."));

export default { port: config.port, fetch: app.fetch };
