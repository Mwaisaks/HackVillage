/**
 * Currency-aware money formatting for the PayPal rail (HACKATHON.md decision 8:
 * used on demo-path screens; KES screens keep formatKes).
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}

/** "$1,250.50"-style input parsing for forms: "1250.5" → 125050. Null if invalid. */
export function parseMajorToMinor(input: string): number | null {
  const match = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(input.replace(/,/g, ""));
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
}
