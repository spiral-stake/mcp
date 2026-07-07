// Ported from v2-client/src/utils/pt.ts. Only the maturity-date helpers are used by the
// composition (readMarkets), so the unused `isMatured` (which the app uses for on-chain
// maturity checks) is omitted here — this file is not a byte-for-byte gated copy.
export function getMaturityDate(symbol: string) {
  const dateStr = symbol.split("-")[2];

  // Match day (1–2 digits), month (3 letters), and year (4 digits)
  let match;
  try {
    match = dateStr.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
  } catch (e) {
    console.log(`Invalid PT symbol, ${symbol}`);
  }

  if (!match) return dateStr; // Return original if not matching expected format

  const [, day, month, year] = match;
  return `${day} ${month} ${year}`;
}

export function getMaturityDaysLeft(dateString: string): number {
  // Parse the string into a Date
  const targetDate = new Date(dateString);

  // Ensure it's valid
  if (isNaN(targetDate.getTime())) {
    return 0;
  }

  // Normalize today's date (midnight)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Difference in ms → number
  const diff: number = targetDate.getTime() - today.getTime();

  // Convert to days
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}
