import { v1 } from "@cashu/store";
import { finiteFloat } from "./cashInput.js";

export interface CushionInput {
  readonly off: boolean;
  readonly target: number | null;
  readonly months: number | null;
  readonly currency: string | null;
  readonly monthlyMax: number | null;
  readonly accounts: readonly string[] | null;
  readonly changing: boolean;
}

/** Parse native account gids before any write; local numeric ids are never accepted. */
export function cushionInput(args: readonly string[]): CushionInput | null {
  let off = false;
  let target: number | null = null;
  let months: number | null = null;
  let currency: string | null = null;
  let monthlyMax: number | null = null;
  let accounts: string[] | null = null;
  let changing = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const equals = arg.indexOf("=");
    const key = equals < 0 ? arg : arg.slice(0, equals);
    if (key !== "--account" && seen.has(key)) return null;
    if (key === "--off" && equals < 0) {
      off = true;
      changing = true;
      seen.add(key);
      continue;
    }
    if (!["--target", "--months", "--currency", "--monthly-max", "--account"].includes(key))
      return null;
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined) return null;
    changing = true;
    if (key === "--account") {
      if (!v1.gid.safeParse(value).success) return null;
      if (accounts === null) accounts = [];
      accounts.push(value);
      continue;
    }
    seen.add(key);
    if (key === "--target") {
      target = finiteFloat(value);
      if (target === null) return null;
    } else if (key === "--months") {
      if (!/^[0-9]+$/.test(value)) return null;
      months = Number(value);
      if (!Number.isSafeInteger(months)) return null;
    } else if (key === "--currency") currency = value;
    else {
      monthlyMax = finiteFloat(value);
      if (monthlyMax === null) return null;
    }
  }
  return { off, target, months, currency, monthlyMax, accounts, changing };
}
