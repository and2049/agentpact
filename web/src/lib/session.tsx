import * as React from "react"
import { api, type Config, type User } from "@/lib/api"

interface Session {
  me: User | null
  config: Config
  ready: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const EMPTY: Config = { clientId: "", env: "sandbox", devLogin: false, keyCustody: false, templates: [] }
const SessionContext = React.createContext<Session | null>(null)

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = React.useState<User | null>(null)
  const [config, setConfig] = React.useState<Config>(EMPTY)
  const [ready, setReady] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const r = await fetch("/me")
    const j = r.ok ? ((await r.json()) as { user: User | null }) : { user: null }
    setMe(j.user)
  }, [])

  React.useEffect(() => {
    void (async () => {
      const [cfg] = await Promise.all([api<Config>("/api/config").catch(() => EMPTY), refresh()])
      setConfig(cfg)
      setReady(true)
    })()
  }, [refresh])

  const logout = React.useCallback(async () => {
    await api("/logout", { method: "POST" })
    setMe(null)
  }, [])

  const value = React.useMemo(() => ({ me, config, ready, refresh, logout }), [me, config, ready, refresh, logout])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const s = React.useContext(SessionContext)
  if (!s) throw new Error("useSession outside SessionProvider")
  return s
}

/** Load a resource once per key; re-run with `reload`. Errors surface as `error`. */
export function useLoad<T>(fn: () => Promise<T>, deps: React.DependencyList): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = React.useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true })
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState({ data: null, error, loading: false }),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = React.useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}
