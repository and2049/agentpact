/**
 * Scrub secrets from text that will be persisted or shown (task errors, events, logs).
 * Known secrets are replaced exactly; generic key-shaped tokens are replaced by pattern.
 */
const GENERIC = [/\b(?:sk|key|token|bearer|apikey|api_key)[-_ :=]*[A-Za-z0-9_\-.]{12,}/gi, /\b[A-Za-z0-9_\-]{40,}\b/g];

export function redactSecrets(text: string, known: Array<string | undefined | null> = []): string {
  let out = text;
  for (const k of known) if (k && k.length >= 8) out = out.split(k).join("[redacted]");
  for (const re of GENERIC) out = out.replace(re, "[redacted]");
  return out;
}

/** Wrap an error so its message (and nothing else) survives, scrubbed. */
export function redactedError(e: unknown, known: Array<string | undefined | null> = []): Error {
  const msg = redactSecrets(String((e as Error)?.message ?? e), known).slice(0, 500);
  const err = new Error(msg);
  err.name = String((e as Error)?.name ?? "Error");
  return err;
}
