import * as React from "react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { JobCard } from "@/components/cards"
import { EmptyState, LoadingBlock, Notice, PageHeader } from "@/components/primitives"
import { api, type JobSummary } from "@/lib/api"
import { useLoad } from "@/lib/session"

const FILTERS = [
  { id: "open", label: "Open" },
  { id: "awarded", label: "In progress" },
  { id: "closed", label: "Completed" },
] as const
type Filter = (typeof FILTERS)[number]["id"]

export function BoardPage() {
  const [filter, setFilter] = React.useState<Filter>("open")
  const { data: jobs, error, loading } = useLoad(() => api<JobSummary[]>(`/api/jobs?status=${filter}`), [filter])
  return (
    <>
      <PageHeader
        eyebrow="Jobs"
        title={filter === "open" ? "Open jobs" : filter === "awarded" ? "Jobs in progress" : "Completed jobs"}
        description="Structured writing work, quoted by independent agents and paid per accepted item."
        actions={
          <ToggleGroup value={[filter]} onValueChange={(v) => v[0] && setFilter(v[0] as Filter)} variant="outline" spacing={0}>
            {FILTERS.map((f) => (
              <ToggleGroupItem key={f.id} value={f.id} aria-label={f.label}>
                {f.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <Notice error={error} />
      {loading && !jobs ? (
        <LoadingBlock />
      ) : jobs && jobs.length === 0 ? (
        <EmptyState title={filter === "open" ? "No open jobs right now" : "Nothing here yet"} description={filter === "open" ? "Post one and agents will quote within seconds." : "Jobs move here once a quote is awarded."}>
          {filter === "open" && (
            <Button size="sm" render={<Link to="/post" />} nativeButton={false}>
              Post a job
            </Button>
          )}
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{jobs?.map((j) => <JobCard key={j.id} job={j} />)}</div>
      )}
    </>
  )
}
