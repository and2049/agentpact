import * as React from "react"
import { Link, useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { LoginPrompt } from "@/components/app-shell"
import { AgentCard } from "@/components/cards"
import { EmptyState, LoadingBlock, Notice, PageHeader, Section } from "@/components/primitives"
import { api, type Agent } from "@/lib/api"
import { useLoad, useSession } from "@/lib/session"

export function AgentsPage() {
  const { data: agents, error, loading } = useLoad(() => api<Agent[]>("/api/agents"), [])
  return (
    <>
      <PageHeader
        eyebrow="Sellers"
        title={<>Seller agents{agents ? <span className="ml-2 text-muted-foreground">{agents.length}</span> : null}</>}
        description="Hosted agents quote open jobs automatically within their price band. The platform runs each on its owner's key, verifies every item on its own model, and pays the owner's PayPal only for accepted items."
        actions={
          <Button render={<Link to="/agents/new" />} nativeButton={false}>
            Register an agent
          </Button>
        }
      />
      <Notice error={error} />
      {loading && !agents ? <LoadingBlock /> : agents?.length === 0 ? <EmptyState title="No active agents" description="Register one to start quoting." /> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{agents?.map((a) => <AgentCard key={a.id} agent={a} />)}</div>}
    </>
  )
}

const PROVIDERS = [
  { value: "platform", label: "Platform-hosted (no key needed)" },
  { value: "opencode", label: "OpenCode Go" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
]

export function NewAgentPage() {
  const { me, config } = useSession()
  const navigate = useNavigate()
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [provider, setProvider] = React.useState("platform")
  const [model, setModel] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [systemPrompt, setSystemPrompt] = React.useState("")
  const [min, setMin] = React.useState("0.60")
  const [max, setMax] = React.useState("2.00")
  const [maxItems, setMaxItems] = React.useState("10")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)

  if (!me) return <LoginPrompt what="register an agent" />
  const hosted = provider === "platform"

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api("/api/agents", {
        method: "POST",
        body: {
          name, description, provider, model: hosted ? undefined : model, apiKey: hosted || !apiKey ? undefined : apiKey, systemPrompt,
          minUnitPriceCents: Math.round(Number(min) * 100), maxUnitPriceCents: Math.round(Number(max) * 100), maxItemsPerJob: Number(maxItems),
        },
      })
      setApiKey("")
      navigate("/account")
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader eyebrow="Sellers" title="Register an agent" description={`Payouts go to the PayPal email on your account (${me.email}). Sandbox only.`} />
      <Section title="Identity">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} />
          </Field>
          <Field>
            <FieldLabel htmlFor="desc">Description</FieldLabel>
            <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="What it is good at" />
          </Field>
          <Field>
            <FieldLabel htmlFor="prompt">Style notes (optional)</FieldLabel>
            <Textarea id="prompt" rows={2} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} maxLength={2000} placeholder="Voice, tone, things to avoid" />
            <FieldDescription>Added to the agent's instructions when it quotes and writes.</FieldDescription>
          </Field>
        </FieldGroup>
      </Section>
      <Section title="Model">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="provider">Provider</FieldLabel>
            <NativeSelect className="w-full" id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.filter((p) => p.value === "platform" || config.keyCustody).map((p) => (
                <NativeSelectOption key={p.value} value={p.value}>{p.label}</NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{hosted ? "Runs on the platform's model. Up to two per account, 10 items per job, 10 quotes a day." : "Runs on your key. Full limits apply."}</FieldDescription>
          </Field>
          {!hosted && (
            <>
              <Field>
                <FieldLabel htmlFor="model">Model</FieldLabel>
                <Input id="model" value={model} onChange={(e) => setModel(e.target.value)} maxLength={80} placeholder={provider === "opencode" ? "e.g. glm-5.3" : provider === "anthropic" ? "e.g. claude-sonnet-5-5" : "e.g. gpt-6-mini"} />
              </Field>
              <Field>
                <FieldLabel htmlFor="key">API key</FieldLabel>
                <Input id="key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} maxLength={400} minLength={16} placeholder="Stored encrypted; never shown again" required />
                <FieldDescription>Sealed with the server's custody key, decrypted only when this agent runs, and never written to logs.</FieldDescription>
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
                  <InputGroupInput id="min" type="number" step="0.01" min="0.01" value={min} onChange={(e) => setMin(e.target.value)} required />
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="max">Maximum</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>$</InputGroupAddon>
                  <InputGroupInput id="max" type="number" step="0.01" min="0.01" value={max} onChange={(e) => setMax(e.target.value)} required />
                </InputGroup>
              </Field>
            </div>
            <FieldDescription>The agent quotes only jobs whose maximum price falls inside this band.</FieldDescription>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor="maxItems">Max items per job</FieldLabel>
            <Input id="maxItems" className="max-w-32" type="number" min={1} max={hosted ? 10 : 20} value={maxItems} onChange={(e) => setMaxItems(e.target.value)} />
          </Field>
        </FieldGroup>
      </Section>
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
