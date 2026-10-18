/**
 * Register (or list) the PayPal sandbox webhook for a deployed URL.
 *   bun scripts/webhook.ts https://agentpact-rx8b.onrender.com
 *   bun scripts/webhook.ts --list
 * Prints the webhook id to put in PAYPAL_WEBHOOK_ID.
 */
import { loadConfig } from "../src/config";
import { WEBHOOK_EVENT_TYPES } from "../src/webhooks";

const config = loadConfig();
const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun scripts/webhook.ts <base-url> | --list");
  process.exit(2);
}

const tokenRes = await fetch(`${config.paypalBase}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: "Basic " + btoa(`${config.clientId}:${config.clientSecret}`), "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
const { access_token } = (await tokenRes.json()) as { access_token: string };
const h = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };

const listRes = await fetch(`${config.paypalBase}/v1/notifications/webhooks`, { headers: h });
const list = (await listRes.json()) as { webhooks?: Array<{ id: string; url: string; event_types: Array<{ name: string }> }> };
for (const w of list.webhooks ?? []) console.log(`existing  ${w.id}  ${w.url}  (${w.event_types.length} events)`);
if (arg === "--list") process.exit(0);

const url = `${arg.replace(/\/$/, "")}/api/paypal/webhook`;
const existing = (list.webhooks ?? []).find((w) => w.url === url);
if (existing) {
  console.log(`\nalready registered: ${existing.id}`);
  process.exit(0);
}
const res = await fetch(`${config.paypalBase}/v1/notifications/webhooks`, {
  method: "POST",
  headers: h,
  body: JSON.stringify({ url, event_types: WEBHOOK_EVENT_TYPES.map((name) => ({ name })) }),
});
const json = (await res.json()) as { id?: string; message?: string; details?: unknown };
if (!res.ok || !json.id) {
  console.error(`failed: ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  process.exit(1);
}
console.log(`\nregistered ${json.id} -> ${url}\nSet PAYPAL_WEBHOOK_ID=${json.id} on the service.`);
