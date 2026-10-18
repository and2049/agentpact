import * as React from "react"
import { cn } from "cn"
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Notice } from "@/components/primitives"
import { api } from "@/lib/api"
import { useSession } from "@/lib/session"

const NAV: Array<{ to: string; label: string; end?: boolean }> = [
  { to: "/", label: "Jobs", end: true },
  { to: "/agents", label: "Agents" },
  { to: "/samples", label: "Sample runs" },
  { to: "/account", label: "Account" },
]

export function AppShell() {
  const { me, config, logout } = useSession()
  const navigate = useNavigate()
  const [devOpen, setDevOpen] = React.useState(false)

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3 md:px-6">
          <Link to="/" className="flex items-baseline gap-2 font-heading text-lg font-semibold tracking-tight">
            AgentPact
            <span className="eyebrow hidden sm:inline">pay on acceptance</span>
          </Link>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cn("rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", isActive && "bg-muted text-foreground")
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <Separator orientation="vertical" className="hidden h-5 sm:block" />
          <div className="flex items-center gap-2 text-sm">
            {me ? (
              <>
                <span className="hidden max-w-40 truncate text-muted-foreground md:inline" title={me.email}>
                  {me.name}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    await logout()
                    navigate("/")
                  }}
                >
                  Log out
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" render={<a href="/auth/paypal/start" />} nativeButton={false}>
                  Log in with PayPal
                </Button>
                {config.devLogin && (
                  <Button variant="ghost" size="sm" onClick={() => setDevOpen(true)}>
                    Dev login
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 md:px-6">
        <Outlet context={{ openDevLogin: () => setDevOpen(true) }} />
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-4 font-mono text-[11px] text-muted-foreground md:px-6">
          <span>Sandbox only</span>
          <span>Orders v2 AUTHORIZE → per-item verification → partial or final capture, or void → Payouts</span>
          <a className="ml-auto underline underline-offset-4 hover:text-foreground" href="https://github.com/and2049/agentpact" rel="noopener">
            Source
          </a>
        </div>
      </footer>

      <DevLoginDialog open={devOpen} onOpenChange={setDevOpen} />
    </div>
  )
}

function DevLoginDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { refresh } = useSession()
  const [who, setWho] = React.useState<"buyer" | "seller">("buyer")
  const [passcode, setPasscode] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api("/auth/dev", { method: "POST", body: { who, passcode } })
      await refresh()
      setPasscode("")
      onOpenChange(false)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Dev login</DialogTitle>
            <DialogDescription>Sign in as one of the two seeded sandbox accounts. Needs the server's dev passcode.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="dev-who">Account</FieldLabel>
              <NativeSelect className="w-full" id="dev-who" value={who} onChange={(e) => setWho(e.target.value as "buyer" | "seller")}>
                <NativeSelectOption value="buyer">Demo Buyer</NativeSelectOption>
                <NativeSelectOption value="seller">Demo Seller</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="dev-pass">Passcode</FieldLabel>
              <Input id="dev-pass" type="password" autoComplete="off" value={passcode} onChange={(e) => setPasscode(e.target.value)} required />
              <FieldDescription>Set by DEV_LOGIN_PASSCODE on the server.</FieldDescription>
            </Field>
          </FieldGroup>
          <Notice error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !passcode}>
              {busy && <Spinner data-icon="inline-start" />}
              Log in
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Shown in place of a page that needs an account. */
export function LoginPrompt({ what }: { what: string }) {
  const { config } = useSession()
  const ctx = useOutletContextSafe()
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-xl bg-card p-6 ring-1 ring-foreground/10">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-medium">Log in to {what}</h2>
        <p className="text-sm text-muted-foreground">PayPal sandbox accounts only. Your PayPal email is where seller payouts go.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button render={<a href="/auth/paypal/start" />} nativeButton={false}>
          Log in with PayPal
        </Button>
        {config.devLogin && ctx && (
          <Button variant="outline" onClick={ctx.openDevLogin}>
            Dev login
          </Button>
        )}
      </div>
    </div>
  )
}

import { useOutletContext } from "react-router-dom"
function useOutletContextSafe(): { openDevLogin: () => void } | null {
  try {
    return useOutletContext<{ openDevLogin: () => void }>() ?? null
  } catch {
    return null
  }
}
