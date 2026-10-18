/** What the buyer bought: accepted items in full (first few open, the rest folded), rejected SKUs by reason only, downloads. */
import * as React from "react"
import { ChevronDownIcon, DownloadIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { Section } from "@/components/primitives"
import type { Deliverable as DeliverableShape } from "@/lib/api"

const PREVIEW = 3

export function Deliverable({ pactId, d }: { pactId: string; d: DeliverableShape }) {
  const n = d.accepted.length
  const [showAll, setShowAll] = React.useState(false)
  return (
    <Section
      title="Deliverable"
      description={`${n} accepted · ${d.rejected.length} rejected · you paid for accepted items only`}
      aside={
        n > 0 && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" render={<a href={`/api/pacts/${pactId}/deliverable?format=md`} />} nativeButton={false}>
              <DownloadIcon data-icon="inline-start" />
              .md
            </Button>
            <Button size="sm" variant="outline" render={<a href={`/api/pacts/${pactId}/deliverable?format=csv`} />} nativeButton={false}>
              <DownloadIcon data-icon="inline-start" />
              .csv
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
