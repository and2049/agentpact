import * as React from "react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { QuoteCard } from "@/components/cards"
import { EmptyState, LoadingBlock, Meta, MetaList, Notice, PageHeader, Section, StatusBadge } from "@/components/primitives"
import { api, ApiError, type JobDetail } from "@/lib/api"
import { cents, plural, when } from "@/lib/format"
import { useLoad } from "@/lib/session"

export function JobPage() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { data: j, error, loading, reload } = useLoad(() => api<JobDetail>(`/api/jobs/${id}`), [id])
  const [awarding, setAwarding] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<unknown>(null)

  // Quotes arrive asynchronously; poll while agents are still quoting.
  React.useEffect(() => {
    if (!j?.quoting) return
    const t = setTimeout(reload, 3000)
    return () => clearTimeout(t)
  }, [j, reload])

  if (error) return <Notice error={error} />
  if (!j) return <LoadingBlock />

  const quotes = j.quotes ?? []
  const award = async (quoteId: string) => {
    setAwarding(quoteId)
    setActionError(null)
    try {
      const r = await api<{ pactId: string }>(`/api/jobs/${id}/award`, { method: "POST", body: { quoteId } })
      navigate(`/pacts/${r.pactId}`)
    } catch (e) {
      setAwarding(null)
      setActionError(e)
      if (e instanceof ApiError && typeof e.body.pactId === "string") navigate(`/pacts/${e.body.pactId}`)
    }
  }
  const cancel = async () => {
    try {
      await api(`/api/jobs/${id}/cancel`, { method: "POST" })
      reload()
    } catch (e) {
      setActionError(e)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Job"
        title={j.title}
        badge={<StatusBadge status={j.status} />}
        description={j.brief}
        actions={
          <>
            {j.pact_id && (
              <Button render={<Link to={`/pacts/${j.pact_id}`} />} nativeButton={false}>
                Open pact
              </Button>
            )}
            {j.mine && j.status !== "OPEN" && (
              <Button variant="outline" render={<Link to={`/post?from=${j.id}`} />} nativeButton={false}>
                Post a similar job
              </Button>
            )}
            {j.mine && j.status === "OPEN" && (
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="outline" />}>Cancel job</AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel this job?</AlertDialogTitle>
                    <AlertDialogDescription>Quotes are discarded. Nothing was authorized or reserved.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it open</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={cancel}>
                      Cancel job
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </>
        }
      />
      <MetaList className="-mt-2">
        <Meta>{plural(j.item_count, "item")}</Meta>
        <Meta mono>max {cents(j.max_unit_price_cents)}/item</Meta>
        <Meta label="buyer">{j.buyer_name}</Meta>
        <Meta>{when(j.created_at)}</Meta>
        {j.rubric && <Meta>{j.rubric.minWords}–{j.rubric.maxWords} words</Meta>}
      </MetaList>
      <Notice error={actionError} />

      {j.restricted ? (
        <Notice variant="default" title="Details are private">
          Items and quotes are visible to the buyer and to sellers whose agents quoted.
        </Notice>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Section title="Items" description={`${j.item_count} SKUs with the facts each description must contain`} className="self-start">
            <div className="-mx-4 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">SKU</TableHead>
                    <TableHead>Facts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {j.items?.map((it) => (
                    <TableRow key={it.sku}>
                      <TableCell className="pl-4 align-top font-mono text-xs">{it.sku}</TableCell>
                      <TableCell className="text-xs whitespace-normal">
                        <span className="font-medium text-foreground">{String(it.facts.name ?? "")}</span>
                        {Object.entries(it.facts)
                          .filter(([k]) => k !== "name")
                          .map(([k, v]) => (
                            <span key={k} className="text-muted-foreground">
                              {" · "}
                              {k}: {String(v)}
                            </span>
                          ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>

          <Section
            title="Quotes"
            description={j.quoting ? "Agents are quoting…" : plural(quotes.length, "quote")}
            aside={j.quoting ? <Spinner className="text-muted-foreground" /> : undefined}
          >
            {quotes.length === 0 ? (
              <EmptyState
                title={j.quoting ? "Waiting for eligible agents" : "No eligible agents quoted"}
                description={j.quoting ? "Quotes appear here as each agent responds." : "Raise the maximum price per item, or check the agents page for who is active."}
              />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {quotes.map((q) => (
                  <QuoteCard key={q.id} quote={q} itemCount={j.item_count} canAward={j.mine && j.status === "OPEN" && q.status === "open"} awarding={awarding === q.id} onAward={() => award(q.id)} />
                ))}
              </div>
            )}
          </Section>
        </div>
      )}
      {loading && <span className="sr-only">Refreshing</span>}
    </>
  )
}
