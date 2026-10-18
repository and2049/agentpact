import * as React from "react"
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom"

import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/components/app-shell"
import { AccountPage } from "@/pages/account"
import { AgentDetailPage, AgentsPage, EditAgentPage, NewAgentPage } from "@/pages/agents"
import { BoardPage } from "@/pages/board"
import { JobPage } from "@/pages/job"
import { HomePage } from "@/pages/landing"
import { OpsPage } from "@/pages/ops"
import { PactPage } from "@/pages/pact"
import { PostJobPage } from "@/pages/post-job"
import { HowItWorksPage, SellPage, WelcomePage } from "@/pages/static"
import { SessionProvider, useSession } from "@/lib/session"

/** Links from the previous hash-routed client (#/pacts/…, #/demo, #/me) still resolve. */
function LegacyHashRedirect() {
  const navigate = useNavigate()
  const { hash } = useLocation()
  React.useEffect(() => {
    if (!hash.startsWith("#/")) return
    const path = hash.slice(1).replace(/^\/demo$/, "/ops").replace(/^\/me$/, "/account")
    navigate(path, { replace: true })
  }, [hash, navigate])
  return null
}

function ScrollToTop() {
  const { pathname } = useLocation()
  React.useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

/** A render error shows a message instead of a blank page. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto flex max-w-md flex-col gap-3 p-6 text-sm">
          <p className="font-medium">Something went wrong on this page.</p>
          <p className="text-muted-foreground">{this.state.error.message}</p>
          <a href="/" className="underline underline-offset-4">Back to the start</a>
        </div>
      )
    }
    return this.props.children
  }
}

function Routed() {
  const { ready } = useSession()
  if (!ready) return null
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="jobs" element={<BoardPage />} />
        <Route path="post" element={<PostJobPage />} />
        <Route path="jobs/:id" element={<JobPage />} />
        <Route path="pacts/:id" element={<PactPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/new" element={<NewAgentPage />} />
        <Route path="agents/:id" element={<AgentDetailPage />} />
        <Route path="agents/:id/edit" element={<EditAgentPage />} />
        <Route path="sell" element={<SellPage />} />
        <Route path="how-it-works" element={<HowItWorksPage />} />
        <Route path="welcome" element={<WelcomePage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="ops" element={<OpsPage />} />
        <Route path="samples" element={<Navigate to="/ops" replace />} />
        <Route path="demo" element={<Navigate to="/ops" replace />} />
        <Route path="me" element={<Navigate to="/account" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <TooltipProvider>
          <Toaster>
            <LegacyHashRedirect />
            <ScrollToTop />
            <ErrorBoundary>
              <Routed />
            </ErrorBoundary>
          </Toaster>
        </TooltipProvider>
      </SessionProvider>
    </BrowserRouter>
  )
}
