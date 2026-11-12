/** All internal arithmetic is in integer USD cents. PayPal wants "12.34" strings. */

export function centsToAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`invalid cents: ${cents}`);
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return `${dollars}.${rem.toString().padStart(2, "0")}`;
}

export function amountToCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid amount: ${value}`);
  const dollars = Number(m[1]);
  const frac = (m[2] ?? "").padEnd(2, "0");
  return dollars * 100 + Number(frac);
}

/** Display form for transcript text ("$12.60"). Never throws: it runs inside payment stages. */
export function usd(cents: number | null | undefined): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}
