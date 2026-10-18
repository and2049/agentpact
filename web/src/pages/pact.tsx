import * as React from "react"
import { Link, useParams } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Deliverable } from "@/components/deliverable"
import { buildRows } from "@/components/ledger-rows"
import { PayPalApprove } from "@/components/paypal-approve"
import { LoadingBlock, Meta, MetaList, Notice, PageHeader, RefList, Section, Stat, StatusBadge } from "@/components/primitives"
import { Transcript, type Entry, type Level } from "@/components/transcript"

// AG Grid is the heaviest dependency; load it only on this page.
const Ledger = React.lazy(() => import("@/components/ledger").then((m) => ({ default: m.Ledger })))
import { api, ApiError, errorText, type Deliverable as DeliverableShape, type PactDetail, type PactStatus, type Role, type Verdict } from "@/lib/api"
import { cents, stageHint, when } from "@/lib/format"
import { useSession } from "@/lib/session"

const EVENT_TYPES = [
  "stream.end", "run.stalled", "agent.message", "seller.progress", "seller.batch_failed", "fault.injected", "verifier.item", "webhook.received", "run.error", "run.retry", "run.finished",
  "pact.created", "pact.offered", "pact.agreed", "pact.rejected", "pact.held", "pact.hold_failed", "pact.checkout_expired", "pact.delivered", "pact.verified", "pact.settling", "pact.settled", "pact.settlement_failed", "pact.paid_out",
  "mandate.reserved", "mandate.violation", "checkout.order_created", "checkout.failed", "checkout.unknown", "checkout.order_mismatch", "checkout.amount_mismatch",
  "hold.failed", "hold.unknown", "hold.no_authorization", "hold.not_created", "settle.failed", "settle.unknown", "settle.void_not_confirmed", "settle.capture_failed", "settle.capture_pending",
  "payout.sent", "payout.pending", "payout.not_sent",
]
const REFRESH_ON = new Set(["pact.held", "pact.settled", "pact.paid_out", "pact.checkout_expired", "pact.rejected", "pact.hold_failed", "pact.settlement_failed", "run.finished", "run.stalled", "checkout.order_created"])

type D = Record<string, unknown>
const str = (v: unknown) => (v == null ? "" : String(v))
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])

/** Map one server event to a transcript entry (or none); `technical` entries hide behind the toggle. */
function entryFor(type: string, d: D): { role: Role; text: string } | { text: string; level: Level; technical: boolean } | null {
  switch (type) {
    case "agent.message": return { role: d.role as Role, text: str(d.text) }
    case "seller.progress": return { text: `Seller wrote ${list(d.skus).join(", ")}`, level: "info", technical: false }
    case "fault.injected": return { text: `Fault injected and disclosed: ${str(d.note)}.${list(d.dropped).length ? ` Dropped ${list(d.dropped).join(", ")}.` : ""}${Array.isArray(d.corrupted) && d.corrupted.length ? ` Corrupted ${(d.corrupted as Array<{ sku: string; fact: string }>).map((c) => `${c.sku}.${c.fact}`).join(", ")}.` : ""}`, level: "warn", technical: false }
    case "checkout.order_created": return { text: `PayPal order created for ${cents(Number(d.amountCents))}; waiting for the buyer's approval`, level: "info", technical: false }
    case "pact.held": return { text: `Authorization ${str(d.authorizationId)} created for ${cents(Number(d.amountCents))}${d.via ? ` via ${str(d.via)}` : ""}`, level: "ok", technical: false }
    case "pact.settling": return { text: `Settlement: ${str(d.kind)}; charge ${cents(Number(d.chargeCents))}, release ${cents(Number(d.releasedCents))}`, level: "info", technical: false }
    case "pact.settled": return { text: d.captureId ? `Captured ${cents(Number(d.chargeCents))} (capture ${str(d.captureId)})` : `Authorization voided; ${cents(Number(d.releasedCents))} released`, level: "ok", technical: false }
    case "pact.paid_out": return { text: `Paid ${cents(Number(d.amountCents))} to ${str(d.receiver)} (payout ${str(d.payoutItemId)})`, level: "ok", technical: false }
    case "pact.rejected": return { text: `Rejected${d.enforced ? " (server-enforced)" : ""}: ${str(d.reason)}`, level: "bad", technical: false }
    case "pact.checkout_expired": return { text: "Approval deadline passed; reservation released and the job reopened", level: "bad", technical: false }
    case "run.stalled": return { text: `Stalled at ${str(d.stage)}: ${str(d.message)} (recovers on the next restart)`, level: "bad", technical: false }
    case "mandate.violation": case "hold.failed": case "settle.failed": case "pact.hold_failed": case "pact.settlement_failed": case "run.error": case "checkout.failed":
      return { text: `${type}: ${str(d.message ?? d.code ?? d.status ?? JSON.stringify(d).slice(0, 160))}`, level: "bad", technical: false }
    case "seller.batch_failed": return { text: `Seller batch ${list(d.skus).join(", ")} failed (attempt ${str(d.attempt)}): ${str(d.message)}`, level: "warn", technical: true }
    case "run.retry": return { text: `Retrying after an error (attempt ${str(d.attempt)}): ${str(d.message)}`, level: "warn", technical: true }
    case "webhook.received": return { text: `webhook ${str(d.type)} → ${str(d.status)}`, level: "info", technical: true }
    case "payout.sent": return { text: `payout sent: ${str(d.itemStatus ?? d.status)}`, level: "info", technical: true }
    case "payout.pending": return { text: `payout pending: ${str(d.status)}`, level: "info", technical: true }
    case "settle.capture_pending": return { text: `capture pending: ${str(d.status)}`, level: "info", technical: true }
    case "mandate.reserved": return { text: `reserved ${cents(Number(d.amountCents))} under the buyer's mandate`, level: "info", technical: true }
    case "run.finished": return { text: `run finished: ${str(d.status)}`, level: d.status === "error" ? "bad" : "info", technical: true }
    case "pact.created": case "pact.offered": case "pact.agreed": case "pact.delivered": case "pact.verified": case "verifier.item": case "stream.end": return null
    default: return { text: `${type}: ${JSON.stringify(d).slice(0, 160)}`, level: "warn", technical: true }
  }
}

export function PactPage() {
  const { id = "" } = useParams()
  const { config } = useSession()
  const [x, setX] = React.useState<PactDetail | null>(null)
  const [error, setError] = React.useState<unknown>(null)
  const [entries, setEntries] = React.useState<Entry[]>([])
  const [liveVerdicts, setLiveVerdicts] = React.useState<Verdict[]>([])
  const [liveStatus, setLiveStatus] = React.useState<PactStatus | null>(null)
  const [unitPrice, setUnitPrice] = React.useState(0)
  const [deliverable, setDeliverable] = React.useState<DeliverableShape | null>(null)
  const [retrying, setRetrying] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const r = await api<PactDetail>(`/api/pacts/${id}`)
      setX(r)
      setLiveStatus(r.pact.status)
      if (r.pact.unit_price_cents) setUnitPrice(r.pact.unit_price_cents)
      if (r.pact.status === "SETTLED" || r.pact.status === "PAID_OUT") setDeliverable(await api<DeliverableShape>(`/api/pacts/${id}/deliverable`))
    } catch (e) {
      setError(e)
    }
  }, [id])

  // Replay + tail. The server ends the stream only when the pact is terminal.
  React.useEffect(() => {
    setX(null); setEntries([]); setLiveVerdicts([]); setLiveStatus(null); setDeliverable(null); setError(null)
    void refresh()
    const es = new EventSource(`/api/pacts/${id}/events`)
    let seq = 0
    const push = (e: Entry) =>
      setEntries((prev) => {
        const last = prev[prev.length - 1]
        if (e.kind === "event" && last?.kind === "event" && last.text === e.text) return [...prev.slice(0, -1), { ...last, count: last.count + 1 }]
        return [...prev, e]
      })
    for (const t of EVENT_TYPES) {
      es.addEventListener(t, (ev) => {
        let d: D = {}
        try { d = JSON.parse((ev as MessageEvent).data) } catch { /* ignore */ }
        const eid = (ev as MessageEvent).lastEventId || `${t}-${seq++}`
        if (t === "stream.end") { es.close(); void refresh(); return }
        if (t === "verifier.item") { setLiveVerdicts((v) => [...v.filter((o) => o.sku !== d.sku), d as unknown as Verdict]); return }
        if (t === "pact.offered" && typeof d.unitPriceCents === "number") setUnitPrice(d.unitPriceCents)
        if (t.startsWith("pact.") && t !== "pact.created") setLiveStatus(t.slice(5).toUpperCase() as PactStatus)
        const e = entryFor(t, d)
        if (e) push("role" in e ? { kind: "message", id: eid, role: e.role, text: e.text } : { kind: "event", id: eid, text: e.text, level: e.level, technical: e.technical, count: 1 })
        if (REFRESH_ON.has(t)) void refresh()
      })
    }
    es.onerror = () => void refresh()
    return () => es.close()
  }, [id, refresh])

  if (error) return <Notice error={error}>{error instanceof ApiError && error.status === 401 ? "Log in to see this pact." : errorText(error)}</Notice>
  if (!x) return <LoadingBlock rows={4} />

  const p = x.pact
  const status = liveStatus ?? p.status
  const settled = status === "SETTLED" || status === "PAID_OUT"
  const shown = status === "SETTLED" && p.settlement_kind === "void" ? "VOIDED" : status
  const verdicts = [...x.items.filter((v) => !liveVerdicts.some((l) => l.sku === v.sku)), ...liveVerdicts]
  const rows = buildRows(x.job.skus, verdicts, unitPrice)
  const stuck = x.viewer?.role === "buyer" && p.kind === "market" && status === "AGREED" && !p.order_id
  const fault = entries.find((e) => e.kind === "event" && e.text.startsWith("Fault injected"))

  const retryCheckout = async () => {
    setRetrying(true)
    try { await api(`/api/pacts/${id}/checkout`, { method: "POST" }) } catch (e) { setError(e) }
    setRetrying(false)
    void refresh()
  }

  return (
    <>
      <PageHeader
        eyebrow={p.kind === "demo" ? `Sample run · ${p.scenario}` : "Marketplace pact"}
        title={x.job.title}
        badge={<StatusBadge status={shown} />}
        description={stageHint(shown, p.kind)}
        actions={p.job_id && <Button variant="outline" render={<Link to={`/jobs/${p.job_id}`} />} nativeButton={false}>View job</Button>}
      />
      <MetaList className="-mt-2">
        <Meta>{p.item_count} items</Meta>
        {unitPrice > 0 && <Meta mono>{cents(unitPrice)}/item</Meta>}
        {p.buyer_name && <Meta label="buyer">{p.buyer_name}</Meta>}
        {p.seller_name && <Meta label="seller">{p.seller_name}{x.agent ? ` · ${x.agent.name}` : ""}</Meta>}
        <Meta>{when(p.created_at)}</Meta>
      </MetaList>

      {x.can_approve && p.order_id && (
        <PayPalApprove pactId={id} orderId={p.order_id} clientId={config.clientId} totalCents={unitPrice * p.item_count} deadline={p.checkout_deadline} onDone={refresh} />
      )}
      {stuck && (
        <Section title="PayPal order not created yet" contentClassName="flex-row flex-wrap items-center justify-between">
          <p className="text-sm text-muted-foreground">The award is recorded but order creation did not complete. Retrying reuses the same idempotency key.</p>
          <Button onClick={retryCheckout} disabled={retrying}>Retry checkout</Button>
        </Section>
      )}
      {settled && deliverable && <Deliverable pactId={id} d={deliverable} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Transcript" className="lg:row-span-2 lg:max-h-[calc(100vh-12rem)]" contentClassName="min-h-0 flex-1">
          <Transcript entries={entries} />
        </Section>
        <Section title="Money" description="Authorized is a hold, not a charge. Released funds never leave the buyer.">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Authorized" value={cents(p.authorized_cents)} />
            <Stat label="Charged" value={settled ? cents(p.charge_cents) : "—"} />
            <Stat label="Released" value={settled ? cents((p.authorized_cents ?? 0) - (p.charge_cents ?? 0)) : "—"} />
            <Stat label="Paid to seller" value={x.payout?.status === "SUCCESS" ? cents(x.payout.amount_cents) : x.payout ? `${x.payout.status.toLowerCase()}…` : "—"} />
          </div>
          <RefList
            rows={[
              ["order", p.order_id ?? x.authorization?.order_id ?? ""],
              ["authorization", x.authorization ? `${x.authorization.id} · ${x.authorization.status}` : ""],
              ["capture", x.capture ? `${x.capture.id} · ${x.capture.status}` : ""],
              ["payout", x.payout ? `${x.payout.item_id} · ${x.payout.status} · ${x.payout.receiver}` : ""],
              ["pact hash", p.pact_hash ? `${p.pact_hash.slice(0, 16)}…` : ""],
              ["deadline", status === "AGREED" && p.checkout_deadline ? when(p.checkout_deadline) : ""],
            ]}
          />
          {fault && <Notice variant="default" title="Fault injection, disclosed">{fault.kind === "event" ? fault.text : ""}</Notice>}
        </Section>
        <Section title="Item ledger" description="One row per SKU: verdict, score, reason (hover for evidence), charge">
          <React.Suspense fallback={<LoadingBlock rows={2} />}>
            <Ledger rows={rows} unitCents={unitPrice} />
          </React.Suspense>
        </Section>
      </div>
    </>
  )
}
