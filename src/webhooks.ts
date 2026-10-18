/**
 * PayPal webhook receiver. Signature-verified, deduplicated by event id.
 * Webhooks only accelerate state: the run loop's polling remains authoritative,
 * and every update goes through the same confirm* functions.
 */
import type { Db } from "./db";
import { appendEvent, now } from "./db";
import { getPact } from "./pact/machine";
import type { Authorization, Capture, PayoutItem } from "./paypal/client";
import { confirmCapture, confirmPayout, type FlowDeps } from "./payments/flow";
import { authorizationForPact, captureForPact, recordAuthorization, recordCapture, recordPayoutItem } from "./payments/resources";

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource?: Record<string, unknown>;
}

export function alreadySeen(db: Db, eventId: string): boolean {
  return Boolean(db.query<{ id: string }, [string]>("SELECT id FROM webhook_events WHERE id = ?").get(eventId));
}

export function markSeen(db: Db, ev: WebhookEvent, resourceId: string | null) {
  db.run("INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id, received_at) VALUES (?, ?, ?, ?)", [ev.id, ev.event_type, resourceId, now()]);
}

/** Apply one verified event. Returns a short description of what happened. */
export async function applyWebhook(deps: FlowDeps, ev: WebhookEvent): Promise<string> {
  const { db } = deps;
  if (alreadySeen(db, ev.id)) return "duplicate";
  const r = (ev.resource ?? {}) as Record<string, unknown>;
  const resourceId = typeof r.id === "string" ? r.id : null;
  markSeen(db, ev, resourceId);

  if (ev.event_type.startsWith("PAYMENT.CAPTURE.")) {
    const cap = r as unknown as Capture;
    const pactId = typeof cap.custom_id === "string" ? cap.custom_id : null;
    if (!pactId || !getPact(db, pactId)) return "capture for unknown pact";
    const auth = authorizationForPact(db, pactId) ?? captureForPact(db, pactId);
    recordCapture(db, pactId, auth ? ("authorization_id" in auth ? auth.authorization_id : auth.id) : "", cap);
    appendEvent(db, pactId, "webhook.received", { type: ev.event_type, captureId: cap.id, status: cap.status });
    await confirmCapture(deps, pactId);
    return `capture ${cap.id} ${cap.status}`;
  }

  if (ev.event_type.startsWith("PAYMENT.AUTHORIZATION.")) {
    const auth = r as unknown as Authorization;
    const pactId = typeof auth.custom_id === "string" ? auth.custom_id : null;
    if (!pactId || !getPact(db, pactId)) return "authorization for unknown pact";
    const existing = authorizationForPact(db, pactId);
    recordAuthorization(db, pactId, existing?.order_id ?? auth.supplementary_data?.related_ids?.order_id ?? "", auth);
    appendEvent(db, pactId, "webhook.received", { type: ev.event_type, authorizationId: auth.id, status: auth.status });
    return `authorization ${auth.id} ${auth.status}`;
  }

  if (ev.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const item = r as unknown as PayoutItem;
    const senderItemId = item.payout_item?.sender_item_id ?? "";
    const pactId = senderItemId.split(":")[0] ?? "";
    if (!pactId || !getPact(db, pactId)) return "payout item for unknown pact";
    recordPayoutItem(db, pactId, `${pactId}:payout`, item);
    appendEvent(db, pactId, "webhook.received", { type: ev.event_type, payoutItemId: item.payout_item_id, status: item.transaction_status });
    await confirmPayout(deps, pactId);
    return `payout item ${item.payout_item_id} ${item.transaction_status}`;
  }

  return `ignored ${ev.event_type}`;
}

export const WEBHOOK_EVENT_TYPES = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
];
