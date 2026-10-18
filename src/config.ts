export type Env = "sandbox" | "live";

export interface Config {
  paypalEnv: Env;
  paypalBase: string;
  clientId: string;
  clientSecret: string;
  sellerEmail: string;
  webhookId: string;
  dbPath: string;
  port: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const paypalEnv: Env = env.PAYPAL_ENV === "live" ? "live" : "sandbox";
  if (paypalEnv === "live") {
    // The design is sandbox-only. Refuse to start against live money.
    throw new Error("PAYPAL_ENV=live is not supported by this project");
  }
  return {
    paypalEnv,
    paypalBase: "https://api-m.sandbox.paypal.com",
    clientId: env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
    sellerEmail: env.SELLER_SANDBOX_EMAIL ?? "",
    webhookId: env.PAYPAL_WEBHOOK_ID ?? "",
    dbPath: env.DB_PATH ?? "data/agentpact.db",
    port: Number(env.PORT ?? 3000),
  };
}
