import { budget } from "@cashu/domain";

export interface MonthCloseInput {
  readonly year: number | null;
  readonly month: number | null;
}

/** Python `parse_month`; malformed CLI values stay with Typer before any native read. */
export function monthCloseInput(args: readonly string[]): MonthCloseInput | null {
  if (args.length === 0) return { year: null, month: null };
  const raw =
    args.length === 2 && args[0] === "--month"
      ? args[1]
      : args.length === 1 && args[0]?.startsWith("--month=")
        ? args[0].slice("--month=".length)
        : undefined;
  if (raw === undefined) return null;
  const parsed = budget.parseMonth(raw);
  return parsed.ok ? { year: parsed.year, month: parsed.month } : null;
}
