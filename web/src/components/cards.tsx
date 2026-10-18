/** Marketplace cards: job, quote, agent. Each is a pure function of its API shape. */
import * as React from "react"
import { cn } from "cn"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { Meta, MetaList, PriceLine, StatusBadge } from "@/components/primitives"
import type { Agent, JobSummary, Quote } from "@/lib/api"
import { ago, cents, pct, plural, providerLabel } from "@/lib/format"

export function JobCard({ job }: { job: JobSummary }) {
  return (
    <Card size="sm" className="relative transition-shadow hover:ring-foreground/25">
      <CardHeader>
        <CardTitle>
          <Link to={`/jobs/${job.id}`} className="after:absolute after:inset-0">
            {job.title}
          </Link>
        </CardTitle>
        <CardDescription className="line-clamp-2">{job.brief}</CardDescription>
        <CardAction>
          <StatusBadge status={job.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="relative">
        <MetaList>
          <Meta>{plural(job.item_count, "item")}</Meta>
          <Meta mono>max {cents(job.max_unit_price_cents)}/item</Meta>
          <Meta>{plural(job.quote_count, "quote")}</Meta>
          <Meta>{job.buyer_name}</Meta>
          <Meta>{ago(job.created_at)}</Meta>
        </MetaList>
      </CardContent>
    </Card>
  )
}

export function AgentCard({ agent, actions, className }: { agent: Agent; actions?: React.ReactNode; className?: string }) {
  const s = agent.stats
  return (
    <Card size="sm" className={cn("relative", className)}>
      <CardHeader>
        <CardTitle>
          <Link to={`/agents/${agent.id}`} className="hover:underline">
            {agent.name}
          </Link>
        </CardTitle>
        {agent.description && <CardDescription className="line-clamp-2">{agent.description}</CardDescription>}
        <CardAction>
          <StatusBadge status={agent.status} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <MetaList>
          <Meta>
            {providerLabel(agent.provider)}
            {agent.model && agent.provider !== "platform" ? ` · ${agent.model}` : ""}
          </Meta>
          <Meta mono>
            {cents(agent.min_unit_price_cents)}–{cents(agent.max_unit_price_cents)}/item
          </Meta>
          <Meta>≤ {agent.max_items_per_job} items/job</Meta>
          <Meta>{s.settled ? `${pct(s.acceptanceRate)} accepted · earned ${cents(s.earnedCents)}` : "no history yet"}</Meta>
          {agent.has_key !== undefined && <Meta>{agent.has_key ? "key stored" : agent.provider === "platform" ? "platform key" : "no key, paused"}</Meta>}
        </MetaList>
      </CardContent>
      {actions && <CardFooter className="gap-2">{actions}</CardFooter>}
    </Card>
  )
}

export function QuoteCard({ quote, itemCount, canAward, awarding, onAward, className }: { quote: Quote; itemCount: number; canAward: boolean; awarding: boolean; onAward: () => void; className?: string }) {
  const a = quote.agent
  const total = quote.unit_price_cents * itemCount
  const pending = quote.status === "pending"
  return (
    <Card size="sm" className={cn(quote.status === "awarded" && "ring-foreground/40", className)}>
      <CardHeader>
        <CardTitle>{a?.name ?? "Agent"}</CardTitle>
        <CardDescription>{pending ? "Working out a price…" : quote.message}</CardDescription>
        <CardAction>
          <StatusBadge status={quote.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!pending && (
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base">
              <PriceLine unitCents={quote.unit_price_cents} count={itemCount} />
            </span>
            <span className="text-xs text-muted-foreground">ETA {quote.eta_minutes} min</span>
          </div>
        )}
        <MetaList>
          <Meta>{quote.seller_name}</Meta>
          {a && <Meta>{providerLabel(a.provider)}</Meta>}
          <Meta>{a?.stats.settled ? `${pct(a.stats.acceptanceRate)} accepted over ${plural(a.stats.settled, "pact")}` : "no history yet"}</Meta>
        </MetaList>
      </CardContent>
      {canAward && !pending && (
        <CardFooter>
          <Button size="sm" disabled={awarding} onClick={onAward} className="w-full sm:w-auto">
            {awarding && <Spinner data-icon="inline-start" />}
            Award and authorize {cents(total)}
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}
