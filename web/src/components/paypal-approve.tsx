/**
 * Buyer approval of a PayPal authorization through the JS SDK v6 (one-time payment session).
 * The order already exists server-side; approval posts the orderId back so the server authorizes it.
 */
import * as React from "react"
import { Spinner } from "@/components/ui/spinner"
import { Section } from "@/components/primitives"
import { api, errorText } from "@/lib/api"
import { cents, when } from "@/lib/format"

declare global {
  interface Window {
    paypal?: { createInstance: (o: { clientId: string; components: string[]; pageType: string }) => Promise<PayPalSdk> }
  }
}
interface PayPalSession { start: (o: { presentationMode: string }, order: Promise<{ orderId: string }>) => Promise<void> }
interface PayPalSdk { createPayPalOneTimePaymentSession: (h: { onApprove: (d: { orderId: string }) => Promise<void>; onCancel: () => void; onError: (e: unknown) => void }) => PayPalSession }

const SDK = "https://www.sandbox.paypal.com/web-sdk/v6/core"
let sdkLoad: Promise<void> | null = null
const loadSdk = () =>
  (sdkLoad ??= new Promise<void>((res, rej) => {
    const s = document.createElement("script")
    s.src = SDK
    s.onload = () => res()
    s.onerror = () => { sdkLoad = null; rej(new Error("PayPal SDK failed to load")) }
    document.head.appendChild(s)
  }))

export function PayPalApprove({ pactId, orderId, clientId, totalCents, deadline, onDone }: { pactId: string; orderId: string; clientId: string; totalCents: number; deadline: string | null; onDone: () => void }) {
  const [log, setLog] = React.useState<string>("")
  const [ready, setReady] = React.useState(false)
  const btn = React.useRef<HTMLElement>(null)
  const session = React.useRef<PayPalSession | null>(null)

  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        await loadSdk()
        if (!alive || !window.paypal) return
        const sdk = await window.paypal.createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" })
        session.current = sdk.createPayPalOneTimePaymentSession({
          async onApprove(d) {
            setLog("Approved. Recording the authorization…")
            try {
              const r = await api<{ status: string }>(`/api/pacts/${pactId}/approve`, { method: "POST", body: { orderId: d.orderId } })
              setLog(`Authorization recorded (${r.status}).`)
            } catch (e) {
              setLog(`Could not authorize: ${errorText(e)}`)
            }
            onDone()
          },
          onCancel: () => setLog("Cancelled in PayPal. You can try again before the deadline."),
          onError: (e) => setLog(`PayPal error: ${e instanceof Error ? e.message : String(e)}`),
        })
        if (alive) setReady(true)
      } catch (e) {
        if (alive) setLog(`SDK error: ${e instanceof Error ? e.message : String(e)}`)
      }
    })()
    return () => { alive = false }
  }, [clientId, pactId, onDone])

  React.useEffect(() => {
    const el = btn.current
    if (!el || !ready) return
    const onClick = async () => {
      try {
        await session.current?.start({ presentationMode: "auto" }, Promise.resolve({ orderId }))
      } catch (e) {
        setLog(`start error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    el.addEventListener("click", onClick)
    return () => el.removeEventListener("click", onClick)
  }, [ready, orderId])

  return (
    <Section title="Your approval is needed" className="ring-foreground/30" contentClassName="grid gap-4 md:grid-cols-[1fr_minmax(240px,320px)] md:items-center">
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium">Approve a {cents(totalCents)} authorization</p>
        <p className="text-sm text-muted-foreground">PayPal holds the amount; nothing is captured until the verifier accepts items. Unaccepted items are released.{deadline ? ` Deadline ${when(deadline)}.` : ""}</p>
      </div>
      <div className="flex flex-col gap-2">
        {ready ? React.createElement("paypal-button", { type: "pay", ref: btn }) : <span className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading PayPal…</span>}
        {log && <p className="text-xs text-muted-foreground">{log}</p>}
      </div>
    </Section>
  )
}
