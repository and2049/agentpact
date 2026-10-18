/**
 * Seller API keys at rest: AES-256-GCM with a fresh nonce under a server key
 * derived from AGENT_KEY_SECRET (env only, never in SQLite). Output format:
 * base64(iv) + "." + base64(ciphertext). Keys are write-only through the API.
 */
async function keyFor(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const b64 = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf as Uint8Array).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export async function seal(plain: string, secret: string): Promise<string> {
  if (!secret) throw new Error("AGENT_KEY_SECRET is not set; key custody is unavailable");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(secret), new TextEncoder().encode(plain));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function open(sealed: string, secret: string): Promise<string> {
  if (!secret) throw new Error("AGENT_KEY_SECRET is not set; key custody is unavailable");
  const [ivB, ctB] = sealed.split(".");
  if (!ivB || !ctB) throw new Error("malformed sealed value");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB) }, await keyFor(secret), unb64(ctB));
  return new TextDecoder().decode(pt);
}

/** Show only enough of a key to recognise it. */
export function keyHint(plain: string): string {
  return plain.length <= 8 ? "••••" : `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}
