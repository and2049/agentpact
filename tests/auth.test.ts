import { describe, expect, test } from "bun:test";
import { createSession, deleteSession, devLogin, parseCookies, upsertUser, userForSession, userFromPayPal } from "../src/auth";
import { openDb } from "../src/db";

describe("auth", () => {
  test("upsert is keyed by provider identity and updates profile", () => {
    const db = openDb();
    const a = upsertUser(db, { provider: "paypal", providerUserId: "p1", name: "A", email: "a@x" });
    const b = upsertUser(db, { provider: "paypal", providerUserId: "p1", name: "A2", email: "a2@x" });
    expect(b.id).toBe(a.id);
    expect(b.email).toBe("a2@x");
    const c = upsertUser(db, { provider: "dev", providerUserId: "p1", name: "C", email: "c@x" });
    expect(c.id).not.toBe(a.id);
  });

  test("sessions resolve, expire and delete", () => {
    const db = openDb();
    const u = upsertUser(db, { provider: "paypal", providerUserId: "p1", name: "A", email: "a@x" });
    const s = createSession(db, u.id);
    expect(userForSession(db, s.id)?.id).toBe(u.id);
    expect(userForSession(db, "nope")).toBeNull();
    expect(userForSession(db, undefined)).toBeNull();
    const short = createSession(db, u.id, -1);
    expect(userForSession(db, short.id)).toBeNull();
    deleteSession(db, s.id);
    expect(userForSession(db, s.id)).toBeNull();
  });

  test("paypal userinfo mapping handles emails[] and email", () => {
    expect(userFromPayPal({ user_id: "https://www.paypal.com/webapps/auth/identity/user/abc", name: "Pat", emails: [{ value: "p@x", primary: true }] })).toEqual({ providerUserId: "https://www.paypal.com/webapps/auth/identity/user/abc", name: "Pat", email: "p@x" });
    expect(userFromPayPal({ payer_id: "PAYER1", email: "q@x" })?.name).toBe("q@x");
    expect(userFromPayPal({ user_id: "u" })).toBeNull();
  });

  test("dev login is passcode gated and seeded", () => {
    const db = openDb();
    expect(devLogin(db, { passcode: "x", who: "buyer", env: {} })).toBeNull();
    expect(devLogin(db, { passcode: "x", who: "buyer", env: { DEV_LOGIN_PASSCODE: "y" } })).toBeNull();
    const u = devLogin(db, { passcode: "y", who: "seller", env: { DEV_LOGIN_PASSCODE: "y", SELLER_SANDBOX_EMAIL: "s@sb" } });
    expect(u?.email).toBe("s@sb");
    expect(devLogin(db, { passcode: "y", who: "admin", env: { DEV_LOGIN_PASSCODE: "y" } })).toBeNull();
  });

  test("cookie parsing", () => {
    expect(parseCookies("a=1; sid=abc%20d; b=2")).toEqual({ a: "1", sid: "abc d", b: "2" });
    expect(parseCookies(undefined)).toEqual({});
  });
});
