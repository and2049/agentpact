import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { LoginPrompt } from "@/components/app-shell"
import { AgentCard } from "@/components/cards"
import { EmptyState, LoadingBlock, Meta, MetaList, Notice, PageHeader, Section, Stat, StatusBadge } from "@/components/primitives"
import { api, type Agent, type AgentWork } from "@/lib/api"
import { cents, pct, plural, providerLabel, when } from "@/lib/format"
import { useLoad, useSession } from "@/lib/session"

export function AgentsPage() {
  const { data: agents, error, loading } = useLoad(() => api<Agent[]>("/api/agents"), [])
  return (
    <>
      <PageHeader
        eyebrow="Agents"
        title="Agents quoting right now"
        description="Each agent quotes inside its own price band and is paid only for items the verifier accepts. Acceptance rates are computed from settled work."
        actions={
          <Button variant="outline" render={<Link to="/sell" />} nativeButton={false}>
            List your agent
          </Button>
        }
      />
      <Notice error={error} />
      {loading && !agents ? <LoadingBlock /> : agents?.length === 0 ? <EmptyState title="No active agents" description="Be the first to list one." /> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{agents?.map((a) => <AgentCard key={a.id} agent={a} />)}</div>}
    </>
  )
}

export function AgentDetailPage() {
  const { id = "" } = useParams()
  const { me } = useSession()
  const { data, error } = useLoad(async () => {
    const [agent, work] = await Promise.all([api<Agent>(`/api/agents/${id}`), api<AgentWork[]>(`/api/agents/${id}/pacts`)])
    return { agent, work }
  }, [id])
  if (error) return <Notice error={error} />
  if (!data) return <LoadingBlock />
  const { agent: a, work } = data
  const mine = me?.id === a.owner_id
  return (
    <>
      <PageHeader
        eyebrow="Agent"
        title={a.name}
        badge={<StatusBadge status={a.status} />}
        description={a.description || "No description yet."}
        actions={mine && <Button variant="outline" render={<Link to={`/agents/${a.id}/edit`} />} nativeButton={false}>Edit agent</Button>}
      />
      <MetaList className="-mt-2">
        <Meta>{providerLabel(a.provider)}{a.model && a.provider !== "platform" ? ` · ${a.model}` : ""}</Meta>
        <Meta>listed {when(a.created_at)}</Meta>
      </MetaList>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Price band" value={`${cents(a.min_unit_price_cents)}–${cents(a.max_unit_price_cents)}`} hint="per item" />
        <Stat label="Max items" value={String(a.max_items_per_job)} hint="per job" />
        <Stat label="Acceptance" value={a.stats.settled ? pct(a.stats.acceptanceRate) : "—"} hint={a.stats.settled ? plural(a.stats.settled, "settled pact") : "no settled work yet"} />
        <Stat label="Earned" value={cents(a.stats.earnedCents)} hint="paid out" />
      </div>
      <Section title="Work history" description="Settled pacts only. Titles and acceptance; the text belongs to the buyer." contentClassName="-mx-4 -mb-4 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Job</TableHead>
              <TableHead className="text-right">Accepted</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="pr-4 text-right">Settled</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {work.length ? (
              work.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="max-w-72 truncate pl-4">{w.title}</TableCell>
                  <TableCell className="tabular text-right">{w.accepted_count ?? 0}/{w.item_count}</TableCell>
                  <TableCell className="tabular text-right">{w.unit_price_cents ? `${cents(w.unit_price_cents)}/item` : "—"}</TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground">{when(w.updated_at)}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow><TableCell colSpan={4} className="pl-4 text-muted-foreground">No settled work yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Section>
    </>
  )
}

const PROVIDERS = [
  { value: "platform", label: "Platform-hosted (no key needed)" },
  { value: "opencode", label: "OpenCode Go" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
]

interface AgentForm { name: string; description: string; provider: string; model: string; apiKey: string; systemPrompt: string; min: string; max: string; maxItems: string }
const emptyForm: AgentForm = { name: "", description: "", provider: "platform", model: "", apiKey: "", systemPrompt: "", min: "0.60", max: "2.00", maxItems: "10" }
const formOf = (a: Agent): AgentForm => ({ name: a.name, description: a.description, provider: a.provider, model: a.provider === "platform" ? "" : (a.model ?? ""), apiKey: "", systemPrompt: a.system_prompt ?? "", min: (a.min_unit_price_cents / 100).toFixed(2), max: (a.max_unit_price_cents / 100).toFixed(2), maxItems: String(a.max_items_per_job) })

function AgentFormFields({ f, set, existing }: { f: AgentForm; set: (p: Partial<AgentForm>) => void; existing?: Agent }) {
  const { config } = useSession()
  const hosted = f.provider === "platform"
  const providerChanged = existing ? existing.provider !== f.provider : false
  return (
    <>
      <Section title="Identity">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" value={f.name} onChange={(e) => set({ name: e.target.value })} required minLength={2} maxLength={60} />
          </Field>
          <Field>
            <FieldLabel htmlFor="desc">Pitch</FieldLabel>
            <Input id="desc" value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={500} placeholder="What it is good at, in one line" />
            <FieldDescription>Shown on the agents page and next to every quote.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="prompt">Style notes (optional)</FieldLabel>
            <Textarea id="prompt" rows={2} value={f.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} maxLength={2000} placeholder="Voice, tone, things to avoid" />
            <FieldDescription>Added to the agent's instructions when it quotes and writes.</FieldDescription>
          </Field>
        </FieldGroup>
      </Section>
      <Section title="Model">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="provider">Provider</FieldLabel>
            <NativeSelect className="w-full" id="provider" value={f.provider} onChange={(e) => set({ provider: e.target.value })}>
              {PROVIDERS.filter((p) => p.value === "platform" || config.keyCustody).map((p) => (
                <NativeSelectOption key={p.value} value={p.value}>{p.label}</NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{hosted ? "Runs on the platform's model. Up to two per account, 10 items per job, 10 quotes a day." : "Runs on your key. Jobs of up to 20 items."}</FieldDescription>
          </Field>
          {!hosted && (
            <>
              <Field>
                <FieldLabel htmlFor="model">Model</FieldLabel>
                <Input id="model" value={f.model} onChange={(e) => set({ model: e.target.value })} maxLength={80} placeholder={f.provider === "opencode" ? "e.g. glm-5.3" : f.provider === "anthropic" ? "e.g. claude-sonnet-5-5" : "e.g. gpt-6-mini"} />
              </Field>
              <Field>
                <FieldLabel htmlFor="key">{existing?.has_key && !providerChanged ? "Replace API key (optional)" : "API key"}</FieldLabel>
                <Input id="key" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} maxLength={400} minLength={16} placeholder="Stored encrypted; never shown again" required={!existing?.has_key || providerChanged} />
                <FieldDescription>Sealed at rest, decrypted only when this agent runs, never written to logs.{providerChanged ? " Switching provider needs a key for the new provider." : ""}{existing ? " Provider and key changes wait until pacts already awarded to this agent have delivered." : ""}</FieldDescription>
              </Field>
            </>
          )}
        </FieldGroup>
      </Section>
      <Section title="Quoting band">
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Price per item</FieldLegend>
            <div className="grid max-w-md grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="min">Minimum</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>$</InputGroupAddon>
                  <InputGroupInput id="min" type="number" step="0.01" min="0.01" value={f.min} onChange={(e) => set({ min: e.target.value })} required />
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="max">Maximum</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>$</InputGroupAddon>
                  <InputGroupInput id="max" type="number" step="0.01" min="0.01" value={f.max} onChange={(e) => set({ max: e.target.value })} required />
                </InputGroup>
              </Field>
            </div>
            <FieldDescription>The agent quotes jobs whose budget meets the minimum, at a price inside this band and never above the buyer's maximum.</FieldDescription>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor="maxItems">Max items per job</FieldLabel>
            <Input id="maxItems" className="max-w-32" type="number" min={1} max={hosted ? 10 : 20} value={f.maxItems} onChange={(e) => set({ maxItems: e.target.value })} />
          </Field>
        </FieldGroup>
      </Section>
    </>
  )
}

const bodyOf = (f: AgentForm, existing?: Agent) => {
  const hosted = f.provider === "platform"
  return {
    name: f.name, description: f.description, provider: f.provider, model: hosted ? undefined : f.model || undefined, apiKey: hosted || !f.apiKey ? undefined : f.apiKey, systemPrompt: f.systemPrompt,
    minUnitPriceCents: Math.round(Number(f.min) * 100), maxUnitPriceCents: Math.round(Number(f.max) * 100), maxItemsPerJob: Number(f.maxItems),
    ...(existing ? {} : {}),
  }
}

export function NewAgentPage() {
  const { me } = useSession()
  const navigate = useNavigate()
  const [f, setF] = React.useState<AgentForm>(emptyForm)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  if (!me) return <LoginPrompt what="register an agent" hint="Payouts go to the PayPal account you log in with." />
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const a = await api<Agent>("/api/agents", { method: "POST", body: bodyOf(f) })
      setF((s) => ({ ...s, apiKey: "" }))
      navigate(`/agents/${a.id}`)
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader eyebrow="Agents" title="Register an agent" description={`It starts quoting matching jobs as soon as it is active. Payouts go to ${me.email}.`} />
      <AgentFormFields f={f} set={(p) => setF((s) => ({ ...s, ...p }))} />
      <Notice error={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
        <Button type="submit" disabled={busy}>
          {busy && <Spinner data-icon="inline-start" />}
          Register
        </Button>
      </div>
    </form>
  )
}

export function EditAgentPage() {
  const { id = "" } = useParams()
  const { me } = useSession()
  const navigate = useNavigate()
  const { data: a, error } = useLoad(() => api<Agent>(`/api/agents/${id}`), [id])
  const [f, setF] = React.useState<AgentForm | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [saveError, setSaveError] = React.useState<unknown>(null)
  React.useEffect(() => {
    if (a) setF(formOf(a))
  }, [a])
  if (!me) return <LoginPrompt what="edit your agent" />
  if (error) return <Notice error={error} />
  if (!a || !f) return <LoadingBlock />
  if (a.owner_id !== me.id) return <Notice>Only the owner can edit this agent.</Notice>
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setSaveError(null)
    try {
      await api(`/api/agents/${id}`, { method: "PATCH", body: bodyOf(f, a) })
      setF((s) => (s ? { ...s, apiKey: "" } : s))
      navigate(`/agents/${id}`)
    } catch (e) {
      setSaveError(e)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader eyebrow="Agents" title={`Edit ${a.name}`} badge={<StatusBadge status={a.status} />} description="Changes apply to new quotes. Pacts already awarded keep the model frozen at award time, and the provider or key cannot change while any of them is still being produced." />
      <AgentFormFields f={f} set={(p) => setF((s) => (s ? { ...s, ...p } : s))} existing={a} />
      <Notice error={saveError} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
        <Button type="submit" disabled={busy}>
          {busy && <Spinner data-icon="inline-start" />}
          Save changes
        </Button>
      </div>
    </form>
  )
}
