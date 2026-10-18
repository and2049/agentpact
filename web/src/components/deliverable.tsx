/** What the buyer bought: accepted items in full (first few open, the rest folded), rejected SKUs by reason only, downloads. */
import * as React from "react"
import { CheckIcon, ChevronDownIcon, CopyIcon, DownloadIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { Section } from "@/components/primitives"
import type { Deliverable as DeliverableShape } from "@/lib/api"

const PREVIEW = 3

export function Deliverable({ pactId, d }: { pactId: string; d: DeliverableShape }) {
  const n = d.accepted.length
  const [showAll, setShowAll] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    const text = d.accepted.map((i) => `## ${i.title} (${i.sku})\n\n${i.description}`).join("\n\n")
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable: the downloads remain */
    }
  }
  return (
    <Section
      title="Deliverable"
      description={`${n} accepted · ${d.rejected.length} rejected · you paid for accepted items only`}
      aside={
        n > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button size="sm" variant="outline" render={<a href={`/api/pacts/${pactId}/deliverable?format=md`} />} nativeButton={false}>
              <DownloadIcon data-icon="inline-start" />
              .md
            </Button>
            <Button size="sm" variant="outline" render={<a href={`/api/pacts/${pactId}/deliverable?format=csv`} />} nativeButton={false}>
              <DownloadIcon data-icon="inline-start" />
              .csv
            </Button>
            <Button size="sm" variant="outline" render={<a href={`/api/pacts/${pactId}/deliverable`} download={`agentpact-${pactId.slice(0, 8)}.json`} />} nativeButton={false}>
              <DownloadIcon data-icon="inline-start" />
              .json
            </Button>
          </div>
        )
      }
    >
      {n === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing was accepted, so nothing was charged.</p>
      ) : (
        <div className="flex flex-col">
          {(showAll ? d.accepted : d.accepted.slice(0, PREVIEW)).map((i, idx) => (
            <article key={i.sku} className="flex flex-col gap-1 py-3">
              {idx > 0 && <Separator className="mb-3" />}
              <h3 className="flex items-baseline gap-2 text-sm font-medium">
                {i.title}
                <span className="font-mono text-xs text-muted-foreground">{i.sku}</span>
              </h3>
              <p className="text-sm leading-relaxed text-pretty">{i.description}</p>
            </article>
          ))}
          {n > PREVIEW && (
            <div>
              <Button variant="outline" size="sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${n} items`}
              </Button>
            </div>
          )}
        </div>
      )}
      {d.rejected.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            <ChevronDownIcon data-icon="inline-start" />
            {d.rejected.length} rejected item{d.rejected.length === 1 ? "" : "s"} (not charged)
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="flex flex-col gap-1 pt-2 text-sm text-muted-foreground">
              {d.rejected.map((r) => (
                <li key={r.sku} className="flex gap-2">
                  <span className="font-mono text-xs text-foreground/70">{r.sku}</span>
                  <span>{r.reason}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Section>
  )
}
