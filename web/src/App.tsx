import * as React from "react"
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom"

import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/components/app-shell"
import { AccountPage } from "@/pages/account"
import { AgentsPage, NewAgentPage } from "@/pages/agents"
import { BoardPage } from "@/pages/board"
import { JobPage } from "@/pages/job"
import { PactPage } from "@/pages/pact"
import { PostJobPage } from "@/pages/post-job"
import { SamplesPage } from "@/pages/samples"
import { SessionProvider, useSession } from "@/lib/session"

/** Links from the previous hash-routed client (#/pacts/…, #/demo, #/me) still resolve. */
function LegacyHashRedirect() {
  const navigate = useNavigate()
  const { hash } = useLocation()
  React.useEffect(() => {
    if (!hash.startsWith("#/")) return
    const path = hash.slice(1).replace(/^\/demo$/, "/samples").replace(/^\/me$/, "/account")
    navigate(path, { replace: true })
  }, [hash, navigate])
  return null
}

function Routed() {
  const { ready } = useSession()
  if (!ready) return null
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<BoardPage />} />
        <Route path="post" element={<PostJobPage />} />
        <Route path="jobs/:id" element={<JobPage />} />
        <Route path="pacts/:id" element={<PactPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/new" element={<NewAgentPage />} />
        <Route path="samples" element={<SamplesPage />} />
        <Route path="demo" element={<Navigate to="/samples" replace />} />
        <Route path="account" element={<AccountPage />} />
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
            <Routed />
          </Toaster>
        </TooltipProvider>
      </SessionProvider>
    </BrowserRouter>
  )
}
