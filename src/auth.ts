/**
 * Identity and sessions.
 *  - Log in with PayPal (sandbox): OAuth code flow with `state`, userinfo -> upsert user.
 *  - Dev login: passcode-gated seeded accounts, only when DEV_LOGIN_PASSCODE is set
 *    (the Codex-approved fallback; never an open "enter any email" form).
 * Sessions are server-side rows; the browser holds an opaque httpOnly cookie.
 */
import type { Db } from "./db";
import { now } from "./db";

export interface User {
  id: string;
  provider: "paypal" | "dev";
  provider_user_id: string;
  name: string;
  email: string;
  created_at: string;
}

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function upsertUser(db: Db, u: { provider: User["provider"]; providerUserId: string; name: string; email: string }): User {
  const existing = db
    .query<User, [string, string]>("SELECT * FROM users WHERE provider = ? AND provider_user_id = ?")
    .get(u.provider, u.providerUserId);
  if (existing) {
    db.run("UPDATE users SET name = ?, email = ? WHERE id = ?", [u.name, u.email, existing.id]);
    return { ...existing, name: u.name, email: u.email };
  }
  const id = crypto.randomUUID();
  db.run("INSERT INTO users (id, provider, provider_user_id, name, email, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, u.provider, u.providerUserId, u.name, u.email, now()]);
  return getUser(db, id)!;
}

export function getUser(db: Db, id: string): User | null {
  return db.query<User, [string]>("SELECT * FROM users WHERE id = ?").get(id) ?? null;
}

export function createSession(db: Db, userId: string, ttlMs = SESSION_TTL_MS): { id: string; expiresAt: string } {
  const id = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.run("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [id, userId, now(), expiresAt]);
  return { id, expiresAt };
}

export function userForSession(db: Db, sessionId: string | undefined): User | null {
  if (!sessionId) return null;
  const row = db
    .query<User & { expires_at: string }, [string]>(
      "SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?",
    )
    .get(sessionId);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
    return null;
  }
  const { expires_at: _e, ...user } = row;
  return user;
}

export function deleteSession(db: Db, sessionId: string | undefined) {
  if (sessionId) db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name: string, value: string, opts: { maxAge: number; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${opts.maxAge}${opts.secure ? "; Secure" : ""}`;
}

/** Shape of PayPal's userinfo (schema=paypalv1.1) that we rely on. */
export interface PayPalUserInfo {
  user_id?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  emails?: Array<{ value: string; primary?: boolean; confirmed?: boolean }>;
  payer_id?: string;
}

export function userFromPayPal(info: PayPalUserInfo): { providerUserId: string; name: string; email: string } | null {
  const providerUserId = info.user_id ?? info.payer_id;
  const email = info.email ?? info.emails?.find((e) => e.primary)?.value ?? info.emails?.[0]?.value;
  if (!providerUserId || !email) return null;
  const name = info.name ?? [info.given_name, info.family_name].filter(Boolean).join(" ") ?? email;
  return { providerUserId, name: name || email, email };
}

/** Seeded dev accounts. `email` must be a sandbox account so payouts to a seller land somewhere. */
export const DEV_ACCOUNTS: Record<string, { name: string; emailEnv: string }> = {
  buyer: { name: "Demo Buyer", emailEnv: "BUYER_SANDBOX_EMAIL" },
  seller: { name: "Demo Seller", emailEnv: "SELLER_SANDBOX_EMAIL" },
};

export function devLogin(db: Db, args: { passcode: string; who: string; env: Record<string, string | undefined> }): User | null {
  const expected = args.env.DEV_LOGIN_PASSCODE;
  if (!expected || args.passcode !== expected) return null;
  const acct = DEV_ACCOUNTS[args.who];
  if (!acct) return null;
  const email = args.env[acct.emailEnv] || `${args.who}@dev.local`;
  return upsertUser(db, { provider: "dev", providerUserId: args.who, name: acct.name, email });
}
