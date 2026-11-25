import { fromIsoFormat, type IsoDate, pyStrip, unicodeDecimal } from "@cashu/domain";

export interface CashAddInput {
  readonly amount: number;
  readonly title: string;
  readonly category: string;
  readonly date: IsoDate | null;
  readonly currency: string | null;
}

const DIGITS = "[0-9](?:_?[0-9])*";
const FLOAT = new RegExp(
  `^[+-]?(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?$`,
);

export function finiteFloat(raw: string): number | null {
  const text = pyStrip(raw).replace(/\p{Nd}/gu, (ch) =>
    String(unicodeDecimal(ch.codePointAt(0) ?? 0)),
  );
  if (!FLOAT.test(text)) return null;
  const value = Number(text.replaceAll("_", ""));
  return Number.isFinite(value) ? value : null;
}

function options(
  args: readonly string[],
  allowed: readonly string[],
): { values: Map<string, string>; positional: string[] } | null {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!ended && arg === "--") {
      ended = true;
      continue;
    }
    if (!ended && arg.startsWith("-")) {
      const equals = arg.indexOf("=");
      const key = equals < 0 ? arg : arg.slice(0, equals);
      if (!allowed.includes(key) || values.has(key)) return null;
      const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
      if (value === undefined) return null;
      values.set(key, value);
    } else positional.push(arg);
  }
  return { values, positional };
}

export function cashReadInput(args: readonly string[]): string | null | undefined {
  const parsed = options(args, ["--currency"]);
  if (parsed === null || parsed.positional.length !== 0) return undefined;
  return parsed.values.get("--currency") || null;
}

export function cashAddInput(args: readonly string[]): CashAddInput | null {
  const parsed = options(args, ["--date", "--currency"]);
  if (parsed === null || parsed.positional.length !== 3) return null;
  const amount = finiteFloat(parsed.positional[0] as string);
  if (amount === null) return null;
  const dateRaw = parsed.values.get("--date");
  let date: IsoDate | null = null;
  if (dateRaw !== undefined) {
    try {
      date = fromIsoFormat(dateRaw);
    } catch {
      return null;
    }
    if (Number(date.slice(0, 4)) < 100) return null;
  }
  return {
    amount,
    title: parsed.positional[1] as string,
    category: parsed.positional[2] as string,
    date,
    currency: parsed.values.get("--currency") ?? null,
  };
}
