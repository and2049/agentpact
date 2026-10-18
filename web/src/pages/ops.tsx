/**
 * Operator console. Not linked anywhere public; reachable at /ops for operators only
 * (seeded accounts and the emails in OPERATOR_EMAILS). Holds everything a viewer should not see:
 * the scripted demo, automated runs with fault injection, and system status.
 */
import * as React from "react"
import { Link, useNavigate, useOutletContext } from "react-router-dom"
import { CheckIcon, CircleIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ShellContext } from "@/components/app-shell"
import { SAMPLE_ITEMS } from "@/components/items-editor"
import { Notice, PageHeader, RefList, Section, StatusBadge } from "@/components/primitives"
import { api, ApiError, errorText, type JobDetail, type PactSummary } from "@/lib/api"
import { cents, when } from "@/lib/format"
import { useLoad, useSession } from "@/lib/session"

const SCENARIOS = [
  { id: "good", title: "Good delivery", blurb: "Full capture." },
  { id: "partial", title: "Partial delivery", blurb: "5 items dropped, 3 facts corrupted. Partial capture." },
  { id: "broken", title: "Broken delivery", blurb: "Malformed artifact. Void, nothing charged." },
] as const

const DEMO_JOB = {
  title: "Descriptions for 4 kitchen SKUs",
  brief: "Write one product description per SKU for an online kitchenware store. Mention every supplied fact exactly as given; do not invent claims. Warm, concrete tone.",
  items: [
    { sku: "KIT-001", facts: { name: "Hearth Cast-Iron Skillet", material: "cast iron", diameter_cm: 26, pre_seasoned: "yes" } },
    { sku: "KIT-002", facts: { name: "Brook Chef Knife", material: "high-carbon steel", blade_cm: 20, handle: "walnut" } },
    { sku: "KIT-003", facts: { name: "Meadow Cutting Board", material: "end-grain maple", size_cm: "40x30", finish: "food-safe oil" } },
    { sku: "KIT-004", facts: { name: "Ember Kettle", material: "stainless steel", capacity_l: 1.7, whistle: "yes" } },
  ],
  maxUnitPriceCents: 125,
}

type StepState = "todo" | "running" | "done" | "failed"
interface Step { label: string; state: StepState; detail?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function OpsPage() {
  const { me, config } = useSession()
  const { openDevLogin } = useOutletContext<ShellContext>()
  const navigate = useNavigate()
  const operator = Boolean(me?.operator)
  const { data, error, reload } = useLoad(async () => {
    if (!operator) return null
    const [pacts, active, health] = await Promise.all([api<PactSummary[]>("/api/pacts"), api<{ pactId: string | null }>("/api/demo/active"), api<{ startedAt: string; tasks: Record<string, number>; webhookEvents: number }>("/health")])
    return { demos: pacts.filter((p) => p.kind === "demo").slice(0, 10), active: active.pactId, health }
  }, [operator])
  const [starting, setStarting] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<unknown>(null)
  const [steps, setSteps] = React.useState<Step[]>([])
  const running = steps.some((s) => s.state === "running")

  if (!me || !operator) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-xl bg-card p-6 ring-1 ring-foreground/10">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-lg font-medium">Operator console</h2>
          <p className="text-sm text-muted-foreground">{me ? "This account is not an operator." : "Log in with an operator account."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!me && (
            <Button render={<a href="/auth/paypal/start" />} nativeButton={false}>
              Log in with PayPal
            </Button>
          )}
          {config.devLogin && (
            <Button variant="outline" onClick={openDevLogin}>
              Passcode login
            </Button>
          )}
        </div>
      </div>
    )
  }

  const setStep = (i: number, patch: Partial<Step>) => setSteps((s) => s.map((st, j) => (j === i ? { ...st, ...patch } : st)))

  /** The YouTube walkthrough: post → quotes → award, then hand over to the pact page for the PayPal approval. */
  const runScript = async () => {
    setActionError(null)
    setSteps([
      { label: "Post the demo job as this account", state: "running" },
      { label: "Wait for the agents to quote", state: "todo" },
      { label: "Award the best quote", state: "todo" },
      { label: "Approve the PayPal hold on the pact page (you)", state: "todo" },
    ])
    try {
      const job = await api<JobDetail>("/api/jobs", { method: "POST", body: { template: "product_descriptions", ...DEMO_JOB } })
      setStep(0, { state: "done", detail: job.title })
      setStep(1, { state: "running" })
      let quotes = job.quotes ?? []
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        await sleep(3000)
        const j = await api<JobDetail>(`/api/jobs/${job.id}`)
        quotes = (j.quotes ?? []).filter((q) => q.status === "open")
        setStep(1, { detail: `${quotes.length} quote${quotes.length === 1 ? "" : "s"} so far` })
        if (!j.quoting && quotes.length) break
        if (quotes.length >= 3) break
      }
      if (!quotes.length) throw new Error("No quotes arrived within two minutes.")
      setStep(1, { state: "done", detail: `${quotes.length} quotes` })
      setStep(2, { state: "running" })
      const best = [...quotes].sort((a, b) => a.unit_price_cents - b.unit_price_cents || a.eta_minutes - b.eta_minutes)[0]!
      const r = await api<{ pactId: string }>(`/api/jobs/${job.id}/award`, { method: "POST", body: { quoteId: best.id } })
      setStep(2, { state: "done", detail: `${best.agent?.name ?? "agent"} at ${cents(best.unit_price_cents)}/item` })
      setStep(3, { state: "running", detail: "Opening the pact page…" })
      await sleep(800)
      navigate(`/pacts/${r.pactId}`)
    } catch (e) {
      setSteps((s) => s.map((st) => (st.state === "running" ? { ...st, state: "failed", detail: errorText(e) } : st)))
      setActionError(e)
    }
  }

  const startRun = async (scenario: string) => {
    setStarting(scenario)
    setActionError(null)
    try {
      const r = await api<{ pactId: string }>("/api/demo/runs", { method: "POST", body: { scenario } })
      navigate(`/pacts/${r.pactId}`)
    } catch (e) {
      setStarting(null)
      setActionError(e)
      if (e instanceof ApiError && typeof e.body.pactId === "string") navigate(`/pacts/${e.body.pactId}`)
    }
  }

  return (
    <>
      <PageHeader eyebrow="Operator console" title="Demo controls" description={`Signed in as ${me.name}. Nothing on this page is visible to other accounts.`} />
      <Notice error={error ?? actionError} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Scripted demo" description="Posts a real job from this account, waits for the three personas to quote, awards the cheapest, then opens the pact for you to approve in PayPal. Everything after the approval runs on its own.">
          <div>
            <Button onClick={runScript} disabled={running}>
              {running && <Spinner data-icon="inline-start" />}
              Run the scripted demo
            </Button>
          </div>
          {steps.length > 0 && (
            <ol className="flex flex-col gap-2 text-sm">
              {steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-0.5 size-4 shrink-0">
                    {s.state === "done" ? <CheckIcon className="size-4 text-success" /> : s.state === "failed" ? <XIcon className="size-4 text-destructive" /> : s.state === "running" ? <Spinner /> : <CircleIcon className="size-4 text-muted-foreground/50" />}
                  </span>
                  <span className="flex flex-col">
                    <span>{s.label}</span>
                    {s.detail && <span className="text-xs text-muted-foreground">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="Automated runs" description="A seeded buyer agent hires a seeded seller agent on a stored sandbox card. Faults are injected and disclosed in the transcript. One at a time.">
          {data?.active && (
            <Notice variant="default" title="A run is in progress">
              <Link to={`/pacts/${data.active}`}>Open it</Link>.
            </Notice>
          )}
          <div className="flex flex-col gap-2">
            {SCENARIOS.map((s) => (
              <Button key={s.id} variant="outline" className="h-auto justify-start py-2" disabled={starting !== null} onClick={() => startRun(s.id)}>
                {starting === s.id && <Spinner data-icon="inline-start" />}
                <span className="flex flex-col items-start">
                  <span>{s.title}</span>
                  <span className="text-xs font-normal text-muted-foreground">{s.blurb}</span>
                </span>
              </Button>
            ))}
          </div>
        </Section>

        <Section title="Recent automated runs" contentClassName="-mx-4 -mb-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">When</TableHead>
                <TableHead>Scenario</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead className="pr-4 text-right">Charged</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data ? (
                <TableRow><TableCell colSpan={5} className="pl-4 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : data.demos.length ? (
                data.demos.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-4"><Link to={`/pacts/${p.id}`} className="underline underline-offset-4">{when(p.created_at)}</Link></TableCell>
                    <TableCell className="capitalize">{p.scenario}</TableCell>
                    <TableCell><StatusBadge status={p.status === "SETTLED" && p.settlement_kind === "void" ? "VOIDED" : p.status} /></TableCell>
                    <TableCell className="tabular text-right">{p.accepted_count ?? "—"}/{p.item_count}</TableCell>
                    <TableCell className="tabular pr-4 text-right">{p.charge_cents != null ? cents(p.charge_cents) : "—"}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow><TableCell colSpan={5} className="pl-4 text-muted-foreground">None yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Section>

        <Section title="System" aside={<Button size="sm" variant="ghost" onClick={reload}>Refresh</Button>}>
          {data?.health ? (
            <RefList
              rows={[
                ["started", when(data.health.startedAt)],
                ["tasks", Object.entries(data.health.tasks).map(([k, v]) => `${k} ${v}`).join(" · ")],
                ["webhooks", String(data.health.webhookEvents)],
                ["sample items", `${SAMPLE_ITEMS.length} outdoor SKUs in the post form; ${DEMO_JOB.items.length} kitchen SKUs in the script`],
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </Section>
      </div>
    </>
  )
}
