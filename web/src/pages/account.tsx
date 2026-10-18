import * as React from "react"
import { Link } from "react-router-dom"

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LoginPrompt } from "@/components/app-shell"
import { AgentCard } from "@/components/cards"
import { EmptyState, LoadingBlock, Notice, PageHeader, Section, Stat, StatusBadge } from "@/components/primitives"
import { api, type Me, type PactSummary } from "@/lib/api"
import { cents, plural, providerLabel, when } from "@/lib/format"
import { useLoad, useSession } from "@/lib/session"

function PactTable({ pacts }: { pacts: PactSummary[] }) {
  if (!pacts.length) return <p className="text-sm text-muted-foreground">None yet.</p>
  return (
    <div className="-mx-4 overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Pact</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Accepted</TableHead>
            <TableHead className="text-right">Charged</TableHead>
            <TableHead className="pr-4 text-right">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pacts.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="max-w-64 truncate pl-4">
                <Link to={`/pacts/${p.id}`} className="underline underline-offset-4 hover:text-foreground">{p.title}</Link>
              </TableCell>
              <TableCell><StatusBadge status={p.status} /></TableCell>
              <TableCell className="tabular text-right">{p.accepted_count ?? "—"}/{p.item_count}</TableCell>
              <TableCell className="tabular text-right">{p.charge_cents != null ? cents(p.charge_cents) : p.authorized_cents != null ? `held ${cents(p.authorized_cents)}` : "—"}</TableCell>
              <TableCell className="pr-4 text-right text-xs text-muted-foreground">{when(p.updated_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function AccountPage() {
  const { me } = useSession()
  const { data: d, error, reload } = useLoad(() => (me ? api<Me>("/api/me") : Promise.resolve(null)), [me?.id])
  const [per, setPer] = React.useState("")
  const [agg, setAgg] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [actionError, setActionError] = React.useState<unknown>(null)

  React.useEffect(() => {
    if (d) {
      setPer((d.mandate.max_per_pact_cents / 100).toFixed(2))
      setAgg((d.mandate.max_aggregate_cents / 100).toFixed(2))
    }
  }, [d])

  if (!me) return <LoginPrompt what="see your account" />
  if (error) return <Notice error={error} />
  if (!d) return <LoadingBlock />

  const saveMandate = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setSaving(true)
    setActionError(null)
    try {
      await api("/api/mandate", { method: "PUT", body: { maxPerPactCents: Math.round(Number(per) * 100), maxAggregateCents: Math.round(Number(agg) * 100) } })
      reload()
    } catch (e) {
      setActionError(e)
    } finally {
      setSaving(false)
    }
  }
  const patchAgent = async (id: string, status: "active" | "paused") => {
    try { await api(`/api/agents/${id}`, { method: "PATCH", body: { status } }); reload() } catch (e) { setActionError(e) }
  }
  const deleteKey = async (id: string) => {
    try { await api(`/api/agents/${id}/key`, { method: "DELETE" }); reload() } catch (e) { setActionError(e) }
  }
  const m = d.mandate

  return (
    <>
      <PageHeader eyebrow="Account" title={me.name} description={`${me.email} · ${me.provider === "paypal" ? "Log in with PayPal" : "dev login"}`} />
      <Notice error={actionError} />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Section title="Buying" description="A spending mandate the server enforces on every authorization.">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Reserved" value={cents(m.reserved_cents)} hint="held by open pacts" />
              <Stat label="Spent" value={cents(m.spent_cents)} hint="captured so far" />
            </div>
            <form onSubmit={saveMandate} className="flex flex-col gap-4">
              <FieldGroup className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="per">Max per pact</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>$</InputGroupAddon>
                    <InputGroupInput id="per" type="number" step="0.01" min="1" value={per} onChange={(e) => setPer(e.target.value)} required />
                  </InputGroup>
                </Field>
                <Field>
                  <FieldLabel htmlFor="agg">Max in total</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>$</InputGroupAddon>
                    <InputGroupInput id="agg" type="number" step="0.01" min="1" value={agg} onChange={(e) => setAgg(e.target.value)} required />
                  </InputGroup>
                  <FieldDescription>Across all your pacts.</FieldDescription>
                </Field>
              </FieldGroup>
              <div>
                <Button type="submit" size="sm" variant="outline" disabled={saving}>
                  {saving && <Spinner data-icon="inline-start" />}
                  Save mandate
                </Button>
              </div>
            </form>
          </Section>
          <Section title="My jobs" aside={<Button size="sm" variant="outline" render={<Link to="/post" />} nativeButton={false}>Post a job</Button>}>
            {d.jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto">
                <Table>
                  <TableBody>
                    {d.jobs.map((j) => (
                      <TableRow key={j.id}>
                        <TableCell className="max-w-72 truncate pl-4">
                          <Link to={`/jobs/${j.id}`} className="underline underline-offset-4 hover:text-foreground">{j.title}</Link>
                        </TableCell>
                        <TableCell><StatusBadge status={j.status} /></TableCell>
                        <TableCell className="text-xs text-muted-foreground">{plural(j.quote_count, "quote")}</TableCell>
                        <TableCell className="pr-4 text-right text-xs text-muted-foreground">{when(j.created_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>
          <Section title="Pacts as buyer">
            <PactTable pacts={d.pacts.asBuyer} />
          </Section>
        </div>

        <div className="flex flex-col gap-6">
          <Section title="Selling" description={`Earned ${cents(d.earnedCents)} across paid-out pacts.`} aside={<Button size="sm" variant="outline" render={<Link to="/agents/new" />} nativeButton={false}>Register an agent</Button>}>
            {d.agents.length === 0 ? (
              <EmptyState title="No agents yet" description="Register a platform-hosted agent in a minute, or bring your own key." />
            ) : (
              <div className="flex flex-col gap-3">
                {d.agents.map((a) => (
                  <AgentCard
                    key={a.id}
                    agent={a}
                    actions={
                      <>
                        <Button size="sm" variant="outline" onClick={() => patchAgent(a.id, a.status === "active" ? "paused" : "active")}>
                          {a.status === "active" ? "Pause" : "Activate"}
                        </Button>
                        {a.has_key && (
                          <AlertDialog>
                            <AlertDialogTrigger render={<Button size="sm" variant="ghost" />}>Delete key</AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete the stored {providerLabel(a.provider)} key?</AlertDialogTitle>
                                <AlertDialogDescription>The agent is paused until a new key is supplied. Pacts already awarded keep running on the frozen configuration only if a key is present.</AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Keep it</AlertDialogCancel>
                                <AlertDialogAction variant="destructive" onClick={() => deleteKey(a.id)}>Delete key</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </Section>
          <Section title="Pacts as seller">
            <PactTable pacts={d.pacts.asSeller} />
          </Section>
        </div>
      </div>
    </>
  )
}
