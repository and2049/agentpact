import type { JobStatus, PactStatus, QuoteStatus } from "@/lib/api"

export const cents = (c: number | null | undefined): string => (c == null ? "—" : `$${(c / 100).toFixed(2)}`)

export const when = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""

export const ago = (iso: string | null | undefined): string => {
  if (!iso) return ""
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return when(iso)
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

export const pct = (x: number | null | undefined): string => (x == null ? "—" : `${Math.round(x * 100)}%`)

export type Tone = "neutral" | "success" | "warning" | "destructive" | "info"
export type AnyStatus = PactStatus | JobStatus | QuoteStatus | "active" | "paused" | string

/** Human label and tone for every status the API emits. Codes stay visible in the technical event log. */
export function statusInfo(s: AnyStatus): { label: string; tone: Tone; live?: boolean } {
  switch (s) {
    case "DRAFT": return { label: "Draft", tone: "neutral" }
    case "OFFERED": return { label: "Quoted", tone: "info", live: true }
    case "AGREED": return { label: "Awaiting approval", tone: "warning" }
    case "HELD": return { label: "Funds held", tone: "info", live: true }
    case "DELIVERED": return { label: "Delivered", tone: "info", live: true }
    case "VERIFIED": return { label: "Verified", tone: "info", live: true }
    case "SETTLING": return { label: "Settling", tone: "info", live: true }
    case "SETTLED": return { label: "Settled", tone: "success", live: true }
    case "PAID_OUT": return { label: "Paid out", tone: "success" }
    case "VOIDED": return { label: "Voided", tone: "neutral" }
    case "REJECTED": return { label: "Rejected", tone: "destructive" }
    case "HOLD_FAILED": return { label: "Hold failed", tone: "destructive" }
    case "SETTLEMENT_FAILED": return { label: "Settlement failed", tone: "destructive" }
    case "CHECKOUT_EXPIRED": return { label: "Checkout expired", tone: "destructive" }
    case "OPEN": return { label: "Open", tone: "success" }
    case "AWARDED": return { label: "Awarded", tone: "info" }
    case "CLOSED": return { label: "Closed", tone: "neutral" }
    case "open": return { label: "Open", tone: "success" }
    case "awarded": return { label: "Awarded", tone: "info" }
    case "lost": return { label: "Not chosen", tone: "neutral" }
    case "pending": return { label: "Quoting…", tone: "neutral", live: true }
    case "active": return { label: "Active", tone: "success" }
    case "paused": return { label: "Paused", tone: "neutral" }
    default: return { label: String(s), tone: "neutral" }
  }
}

/** Plain-language explanation of where a pact is, for the status strip. */
export function stageHint(s: PactStatus | "VOIDED", kind: "demo" | "market"): string {
  switch (s) {
    case "VOIDED": return "Nothing was accepted. The authorization was voided and the buyer pays nothing."
    case "DRAFT": case "OFFERED": return "The seller agent is quoting and the buyer is deciding."
    case "AGREED": return kind === "market" ? "Waiting for the buyer to approve the PayPal authorization." : "Placing the authorization."
    case "HELD": return "PayPal holds the amount. The seller agent is working; nothing is charged yet."
    case "DELIVERED": return "Work delivered. The verifier is checking each item."
    case "VERIFIED": return "Verification done. Capturing accepted items and releasing the rest."
    case "SETTLING": return "Capture in progress."
    case "SETTLED": return "Charged for accepted items only. Paying the seller."
    case "PAID_OUT": return "Done. The seller was paid for accepted items; the rest was released."
    case "REJECTED": return "The buyer declined the quote. Nothing was authorized."
    case "HOLD_FAILED": return "PayPal did not authorize the hold. Nothing was charged."
    case "SETTLEMENT_FAILED": return "Capture failed; an operator must reconcile."
    case "CHECKOUT_EXPIRED": return "The approval deadline passed. Nothing was charged and the job reopened."
  }
}

export const providerLabel = (p: string): string =>
  ({ platform: "Platform-hosted", opencode: "OpenCode Go", anthropic: "Anthropic", openai: "OpenAI" })[p] ?? p
