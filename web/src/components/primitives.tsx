/**
 * Small composable building blocks shared by every page: status badge, page header, section card,
 * eyebrow labels, stat tiles, meta rows, notices, loading and empty states. Pages only compose these.
 */
import * as React from "react"
import { cn } from "cn"
import { AlertCircleIcon, InboxIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, EmptyContent } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { errorText } from "@/lib/api"
import { statusInfo, type AnyStatus, type Tone } from "@/lib/format"

const toneVariant: Record<Tone, "secondary" | "success" | "warning" | "destructive" | "info"> = {
  neutral: "secondary",
  success: "success",
  warning: "warning",
  destructive: "destructive",
  info: "info",
}

/** One badge for every status the API emits; label and tone come from `statusInfo`. */
export function StatusBadge({ status, className }: { status: AnyStatus; className?: string }) {
  const s = statusInfo(status)
  return (
    <Badge variant={toneVariant[s.tone]} className={cn("shrink-0", className)} title={String(status)}>
      {s.live && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />}
      {s.label}
    </Badge>
  )
}

export function Eyebrow({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("eyebrow", className)} {...props} />
}

export function PageHeader({ eyebrow, title, description, actions, badge, className }: { eyebrow?: React.ReactNode; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; badge?: React.ReactNode; className?: string }) {
  return (
    <header className={cn("flex flex-col gap-3 md:flex-row md:items-end md:justify-between", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-medium tracking-tight text-balance">{title}</h1>
          {badge}
        </div>
        {description && <p className="max-w-2xl text-sm text-muted-foreground text-pretty">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** A titled card. `title` is the eyebrow-style section label; `aside` sits in the header's action slot. */
export function Section({ title, description, aside, children, className, contentClassName, size }: { title?: React.ReactNode; description?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string; contentClassName?: string; size?: "default" | "sm" }) {
  return (
    <Card className={className} size={size}>
      {(title || aside) && (
        <CardHeader>
          {title && <CardTitle className="eyebrow font-normal">{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
          {aside && <CardAction>{aside}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={cn("flex flex-col gap-4", contentClassName)}>{children}</CardContent>
    </Card>
  )
}

export function Stat({ label, value, hint, className }: { label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-lg bg-muted/60 px-3 py-2.5", className)}>
      <Eyebrow>{label}</Eyebrow>
      <span className="tabular truncate text-lg leading-tight">{value}</span>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

export function MetaList({ className, ...props }: React.ComponentProps<"dl">) {
  return <dl className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground", className)} {...props} />
}
export function Meta({ label, children, mono }: { label?: React.ReactNode; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-1">
      {label && <dt className="eyebrow">{label}</dt>}
      <dd className={cn("text-foreground/80", mono && "tabular")}>{children}</dd>
    </div>
  )
}

/** Key/value reference list (ids, statuses). Values are mono and wrap anywhere. */
export function RefList({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  const shown = rows.filter(([, v]) => v !== "" && v != null && v !== false)
  if (!shown.length) return null
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
      {shown.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="eyebrow self-baseline">{k}</dt>
          <dd className="tabular min-w-0 self-baseline wrap-anywhere text-foreground/80">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export function Notice({ error, title, children, variant = "destructive", className }: { error?: unknown; title?: React.ReactNode; children?: React.ReactNode; variant?: "destructive" | "default"; className?: string }) {
  if (!error && !children) return null
  return (
    <Alert variant={variant} className={className}>
      <AlertCircleIcon />
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children ?? errorText(error)}</AlertDescription>
    </Alert>
  )
}

export function LoadingBlock({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)} aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-16 w-full", i === rows - 1 && "w-2/3")} />
      ))}
    </div>
  )
}

export function EmptyState({ title, description, children, icon: Icon = InboxIcon }: { title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; icon?: React.ComponentType }) {
  return (
    <Empty className="flex-none border py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  )
}

/** Price per item with the total alongside. */
export function PriceLine({ unitCents, count }: { unitCents: number; count: number }) {
  return (
    <span className="tabular">
      ${(unitCents / 100).toFixed(2)}
      <span className="text-muted-foreground">/item · </span>${((unitCents * count) / 100).toFixed(2)}
      <span className="text-muted-foreground"> total</span>
    </span>
  )
}
