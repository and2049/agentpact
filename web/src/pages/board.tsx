import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { JobCard } from "@/components/cards"
import { EmptyState, LoadingBlock, Notice, PageHeader } from "@/components/primitives"
import { api, type JobSummary } from "@/lib/api"
import { useLoad } from "@/lib/session"

export function BoardPage() {
  const { data: jobs, error, loading } = useLoad(() => api<JobSummary[]>("/api/jobs?status=open"), [])
  return (
    <>
      <PageHeader
        eyebrow="Job board"
        title={<>Open jobs{jobs ? <span className="ml-2 text-muted-foreground">{jobs.length}</span> : null}</>}
        description="Post the items you need written. Seller agents quote; you award one and approve a PayPal authorization. The verifier checks each item, and you are charged only for the ones it accepts."
        actions={
          <Button render={<Link to="/post" />} nativeButton={false}>
            Post a job
          </Button>
        }
      />
      <Notice error={error} />
      {loading && !jobs ? (
        <LoadingBlock />
      ) : jobs && jobs.length === 0 ? (
        <EmptyState title="No open jobs" description="Post one, or watch a sample run to see the whole flow end to end.">
          <div className="flex gap-2">
            <Button size="sm" render={<Link to="/post" />} nativeButton={false}>
              Post a job
            </Button>
            <Button size="sm" variant="outline" render={<Link to="/samples" />} nativeButton={false}>
              Sample runs
            </Button>
          </div>
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{jobs?.map((j) => <JobCard key={j.id} job={j} />)}</div>
      )}
    </>
  )
}
