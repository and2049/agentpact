import * as React from "react"
import { cn } from "cn"
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Notice } from "@/components/primitives"
import { api } from "@/lib/api"
import { useSession } from "@/lib/session"

export interface ShellContext { openDevLogin: () => void }

export function AppShell() {
  const { me, logout, awaiting, refreshAwaiting } = useSession()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [devOpen, setDevOpen] = React.useState(false)
  // Pacts waiting for this buyer's approval are easy to lose after navigating away; re-check on every route change.
  React.useEffect(() => {
    if (me) void refreshAwaiting()
  }, [me, pathname, refreshAwaiting])
  const pending = awaiting.filter((a) => pathname !== `/pacts/${a.id}`)
  const nav: Array<{ to: string; label: string; end?: boolean }> = [
    { to: "/jobs", label: "Jobs" },
    { to: "/agents", label: "Agents", end: true },
    ...(me ? [{ to: "/account", label: "Account" }] : []),
    ...(me?.operator ? [{ to: "/ops", label: "Ops" }] : []),
  ]

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 md:px-6">
          <Link to="/" className="font-heading text-lg font-semibold tracking-tight">
            AgentPact
          </Link>
          {/* On phones the nav drops to its own row under the brand and actions. */}
          <nav className="order-last -mx-1 flex w-full items-center gap-1 overflow-x-auto text-sm sm:order-none sm:mx-0 sm:ml-auto sm:w-auto">
            {nav.map((n) => (
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
          <div className="ml-auto flex items-center gap-2 text-sm sm:ml-0">
            <Button size="sm" render={<Link to="/post" />} nativeButton={false}>
              Post a job
            </Button>
            {me ? (
              <Button
                variant="ghost"
                size="sm"
                title={me.email}
                onClick={async () => {
                  await logout()
                  navigate("/")
                }}
              >
                Log out
              </Button>
            ) : (
              <Button variant="outline" size="sm" render={<a href="/auth/paypal/start" />} nativeButton={false}>
                Log in
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 md:px-6">
        {pending.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm">
            <span>
              {pending.length === 1 ? "A pact is waiting for your PayPal approval: " : `${pending.length} pacts are waiting for your PayPal approval, including `}
              <span className="font-medium">{pending[0]!.title}</span>
            </span>
            <Button size="sm" variant="outline" render={<Link to={`/pacts/${pending[0]!.id}`} />} nativeButton={false}>
              Approve now
            </Button>
          </div>
        )}
        <Outlet context={{ openDevLogin: () => setDevOpen(true) } satisfies ShellContext} />
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-1 px-4 py-4 text-xs text-muted-foreground md:px-6">
          <span>AgentPact</span>
          <Link to="/how-it-works" className="hover:text-foreground">
            How it works
          </Link>
          <Link to="/sell" className="hover:text-foreground">
            For agent builders
          </Link>
          <span className="ml-auto">Payments by PayPal</span>
        </div>
      </footer>

      <DevLoginDialog open={devOpen} onOpenChange={setDevOpen} />
    </div>
  )
}

function DevLoginDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { refresh } = useSession()
  const navigate = useNavigate()
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
      navigate("/ops")
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
            <DialogTitle>Operator login</DialogTitle>
            <DialogDescription>Sign in as one of the seeded accounts with the operator passcode.</DialogDescription>
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
export function LoginPrompt({ what, hint }: { what: string; hint?: string }) {
  const { config } = useSession()
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-xl bg-card p-6 ring-1 ring-foreground/10">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-medium">Log in to {what}</h2>
        <p className="text-sm text-muted-foreground">{hint ?? "Sign in with your PayPal account. It takes a few seconds and no password is shared with AgentPact."}</p>
        {config.env !== "live" && <p className="text-xs text-muted-foreground">This deployment runs on PayPal's sandbox: log in with a PayPal sandbox account.</p>}
      </div>
      <div>
        <Button render={<a href="/auth/paypal/start" />} nativeButton={false}>
          Log in with PayPal
        </Button>
      </div>
    </div>
  )
}
