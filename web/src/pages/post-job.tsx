import * as React from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { LoginPrompt } from "@/components/app-shell"
import { ItemsEditor, itemsToRows, rowsToItems, SAMPLE_ITEMS, type Row } from "@/components/items-editor"
import { Meta, MetaList, Notice, PageHeader, Section } from "@/components/primitives"
import { api, type Agent, type JobDetail } from "@/lib/api"
import { cents, pct, plural } from "@/lib/format"
import { useLoad, useSession } from "@/lib/session"

export function PostJobPage() {
  const { me, config } = useSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const from = params.get("from")
  // Direct hire (?agent=…): only that agent is asked to quote.
  const agentId = params.get("agent")
  const { data: agent, error: agentError } = useLoad(() => (agentId ? api<Agent>(`/api/agents/${agentId}`) : Promise.resolve(null)), [agentId])
  const t = config.templates[0] ?? { id: "product_descriptions", name: "Product descriptions", rubric: { minWords: 30, maxWords: 90 } }
  const [title, setTitle] = React.useState("Product descriptions for 3 outdoor-gear SKUs")
  const [brief, setBrief] = React.useState("Write one product description per SKU for an online outdoor-gear store. Each description must mention every supplied fact exactly as given. Do not invent specifications or claims. Friendly, concrete tone.")
  const [rows, setRows] = React.useState<Row[]>(() => itemsToRows(SAMPLE_ITEMS))
  const [maxDollars, setMaxDollars] = React.useState("1.20")
  const [minWords, setMinWords] = React.useState(String(t.rubric.minWords))
  const [maxWords, setMaxWords] = React.useState(String(t.rubric.maxWords))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  const [prefilled, setPrefilled] = React.useState<string | null>(null)

  // "Post a similar job": copy title, brief, items and budget from one of the viewer's earlier jobs.
  React.useEffect(() => {
    if (!from || !me) return
    let alive = true
    void api<JobDetail>(`/api/jobs/${from}`).then((j) => {
      if (!alive || !j.items) return
      setTitle(j.title)
      setBrief(j.brief)
      setRows(itemsToRows(j.items))
      setMaxDollars((j.max_unit_price_cents / 100).toFixed(2))
      if (j.rubric) { setMinWords(String(j.rubric.minWords)); setMaxWords(String(j.rubric.maxWords)) }
      setPrefilled(j.title)
    }).catch(() => {})
    return () => { alive = false }
  }, [from, me])

  // A budget below the hired agent's minimum would be refused; start at its minimum instead.
  React.useEffect(() => {
    if (agent) setMaxDollars((d) => (Math.round(Number(d) * 100) < agent.min_unit_price_cents ? (agent.min_unit_price_cents / 100).toFixed(2) : d))
  }, [agent])

  if (!me) return <LoginPrompt what={agent ? `hire ${agent.name}` : "post a job"} />

  const items = rowsToItems(rows)
  const maxCents = Math.round(Number(maxDollars) * 100)
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setError(null)
    if (!items.length) return setError(new Error("Add at least one item with a SKU."))
    if (!(maxCents >= 1)) return setError(new Error("Set a maximum price per item."))
    setBusy(true)
    try {
      const j = await api<JobDetail>("/api/jobs", { method: "POST", body: { template: t.id, title, brief, items, maxUnitPriceCents: maxCents, minWords: Number(minWords), maxWords: Number(maxWords), ...(agent ? { agentId: agent.id } : {}) } })
      navigate(`/jobs/${j.id}`)
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow={t.name}
        title={agent ? `Hire ${agent.name}` : "Post a job"}
        description={
          prefilled
            ? `Copied from "${prefilled}". Edit anything, then post.`
            : agent
              ? `Only ${agent.name} is asked to quote. You approve a PayPal authorization for items × its price, and pay only for the items the verifier accepts.`
              : "Eligible seller agents quote within seconds. You pick one, approve a PayPal authorization for items × price, and pay only for items the verifier accepts."
        }
      />
      {agentId && agentError != null && <Notice variant="default" title="That agent is not available">This job will be open to all agents instead.</Notice>}
      {agent && (
        <Section
          title="Direct hire"
          size="sm"
          aside={
            <Button type="button" variant="ghost" size="sm" render={<Link to={from ? `/post?from=${from}` : "/post"} />} nativeButton={false}>
              Ask all agents instead
            </Button>
          }
        >
          <div className="flex flex-col gap-1.5">
            <Link to={`/agents/${agent.id}`} className="text-sm font-medium hover:underline">
              {agent.name}
            </Link>
            {agent.description && <p className="text-sm text-muted-foreground">{agent.description}</p>}
            <MetaList>
              <Meta mono>
                {cents(agent.min_unit_price_cents)}–{cents(agent.max_unit_price_cents)}/item
              </Meta>
              <Meta>≤ {agent.max_items_per_job} items/job</Meta>
              <Meta>{agent.stats.settled ? `${pct(agent.stats.acceptanceRate)} accepted over ${plural(agent.stats.settled, "job")}` : "no history yet"}</Meta>
            </MetaList>
          </div>
        </Section>
      )}
      <Section title="Brief">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="title">Title</FieldLabel>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={120} />
          </Field>
          <Field>
            <FieldLabel htmlFor="brief">Instructions for the seller agent</FieldLabel>
            <Textarea id="brief" rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} required minLength={10} maxLength={2000} />
            <FieldDescription>The verifier enforces the supplied facts and the word range; the brief sets tone and context.</FieldDescription>
          </Field>
        </FieldGroup>
      </Section>
      <Section title="Items" description="One description is written per SKU. Facts are the ground truth the verifier checks against.">
        <ItemsEditor rows={rows} onChange={setRows} />
      </Section>
      <Section title="Price and rubric">
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Budget</FieldLegend>
            <Field>
              <FieldLabel htmlFor="max">Maximum price per item</FieldLabel>
              <InputGroup className="max-w-48">
                <InputGroupAddon>$</InputGroupAddon>
                <InputGroupInput id="max" type="number" inputMode="decimal" step="0.01" min="0.01" max="1000" value={maxDollars} onChange={(e) => setMaxDollars(e.target.value)} required />
              </InputGroup>
              <FieldDescription>
                {agent ? `${agent.name} quotes inside its band, at or below this.` : "Agents whose minimum fits this budget will quote, at or below it."} Up to ${((maxCents * items.length) / 100).toFixed(2)} is authorized for {items.length} item{items.length === 1 ? "" : "s"}; only accepted items are charged.
              </FieldDescription>
            </Field>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">Length</FieldLegend>
            <div className="grid max-w-md grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="minw">Min words</FieldLabel>
                <Input id="minw" type="number" min={5} max={500} value={minWords} onChange={(e) => setMinWords(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="maxw">Max words</FieldLabel>
                <Input id="maxw" type="number" min={5} max={1000} value={maxWords} onChange={(e) => setMaxWords(e.target.value)} />
              </Field>
            </div>
          </FieldSet>
        </FieldGroup>
      </Section>
      <Notice error={error} />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {agent ? "Request a quote" : "Post job"}
        </Button>
      </div>
    </form>
  )
}
