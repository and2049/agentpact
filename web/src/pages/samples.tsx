import * as React from "react"
import { Link, useNavigate } from "react-router-dom"

import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Notice, PageHeader, Section, StatusBadge } from "@/components/primitives"
import { api, ApiError, type PactSummary } from "@/lib/api"
import { cents, when } from "@/lib/format"
import { useLoad } from "@/lib/session"

const SCENARIOS = [
  { id: "good", title: "Good delivery", blurb: "The seller does the work. Expect a full capture." },
  { id: "partial", title: "Partial delivery", blurb: "5 items dropped, 3 facts corrupted. Expect a partial capture." },
  { id: "broken", title: "Broken delivery", blurb: "Malformed artifact. Expect a void; nothing charged." },
] as const

export function SamplesPage() {
  const navigate = useNavigate()
  const { data, error } = useLoad(async () => {
    const [pacts, active] = await Promise.all([api<PactSummary[]>("/api/pacts"), api<{ pactId: string | null }>("/api/demo/active")])
    return { demos: pacts.filter((p) => p.kind === "demo"), active: active.pactId }
  }, [])
  const [starting, setStarting] = React.useState<string | null>(null)
  const [startError, setStartError] = React.useState<unknown>(null)

  const start = async (scenario: string) => {
    setStarting(scenario)
    setStartError(null)
    try {
      const r = await api<{ pactId: string }>("/api/demo/runs", { method: "POST", body: { scenario } })
      navigate(`/pacts/${r.pactId}`)
    } catch (e) {
      setStarting(null)
      setStartError(e)
      if (e instanceof ApiError && typeof e.body.pactId === "string") navigate(`/pacts/${e.body.pactId}`)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Sample runs"
        title="See the whole flow in two minutes"
        description="A seeded buyer agent hires a seeded seller agent on a sandbox card hold. Faults are injected and disclosed so you can watch partial and void settlements, not just the happy path."
      />
      <Notice error={error ?? startError} />
      {data?.active && (
        <Notice variant="default" title="A sample run is in progress">
          <Link to={`/pacts/${data.active}`}>Open it</Link> to follow along; only one runs at a time.
        </Notice>
      )}
      <div className="grid gap-3 md:grid-cols-3">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            disabled={starting !== null}
            onClick={() => start(s.id)}
            className="flex flex-col gap-1.5 rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-shadow hover:ring-foreground/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
          >
            <span className="flex items-center justify-between font-heading text-base font-medium">
              {s.title}
              {starting === s.id && <Spinner />}
            </span>
            <span className="text-sm text-muted-foreground">{s.blurb}</span>
          </button>
        ))}
      </div>
      <Section title="Past sample runs" contentClassName="-mx-4 -mb-4 overflow-x-auto">
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
              <TableRow>
                <TableCell colSpan={5} className="pl-4 text-muted-foreground">Loading…</TableCell>
              </TableRow>
            ) : data.demos.length ? (
              data.demos.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-4">
                    <Link to={`/pacts/${p.id}`} className="underline underline-offset-4 hover:text-foreground">{when(p.created_at)}</Link>
                  </TableCell>
                  <TableCell className="capitalize">{p.scenario}</TableCell>
                  <TableCell><StatusBadge status={p.status} /></TableCell>
                  <TableCell className="tabular text-right">{p.accepted_count ?? "—"}/{p.item_count}</TableCell>
                  <TableCell className="tabular pr-4 text-right">{p.charge_cents != null ? cents(p.charge_cents) : "—"}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="pl-4 text-muted-foreground">None yet</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Section>
    </>
  )
}
