// Side-effect-free eligibility parsing. Python retains help, parse errors and unsupported values.
import { D, floatRepr, fromIsoFormat, type IsoDate, pyStrip, unicodeDecimal } from "@cashu/domain";

export interface VehicleInput {
  readonly name: string;
  readonly price: number;
  readonly date: IsoDate;
  readonly rate: number;
  readonly floor: number | null;
  readonly currency?: string;
}
const DIGITS = "[0-9](?:_?[0-9])*";
const FLOAT = new RegExp(
  `^[+-]?(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?$`,
);

function finiteFloat(raw: string): number | undefined {
  const text = pyStrip(raw).replace(/\p{Nd}/gu, (ch) =>
    String(unicodeDecimal(ch.codePointAt(0) ?? 0)),
  );
  if (!FLOAT.test(text)) return undefined;
  const value = Number(text.replaceAll("_", ""));
  return Number.isFinite(value) ? value : undefined;
}

/** Python Decimal(str(Typer float)), represented by the native plain-decimal event grammar. */
export const vehicleDecimal = (value: number): string => D(floatRepr(value)).format("f");

export function vehicleInput(args: readonly string[]): VehicleInput | undefined {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) {
      const equals = arg.indexOf("=");
      const key = equals < 0 ? arg : arg.slice(0, equals);
      if (!["--rate", "--floor", "--currency"].includes(key)) return undefined;
      const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
      if (value === undefined) return undefined;
      options.set(key, value);
    } else positional.push(arg);
  }
  if (positional.length !== 3) return undefined;
  const name = positional[0] as string;
  const price = finiteFloat(positional[1] as string);
  const rate = finiteFloat(options.get("--rate") ?? "15.0");
  const rawFloor = options.get("--floor");
  const floor = rawFloor === undefined ? null : finiteFloat(rawFloor);
  if (price === undefined || rate === undefined || floor === undefined) return undefined;
  let date: IsoDate;
  try {
    date = fromIsoFormat(positional[2] as string);
  } catch {
    return undefined;
  }
  // Current event calendar validation cannot represent Python's years below 100.
  if (Number(date.slice(0, 4)) < 100) return undefined;
  const currency = options.get("--currency");
  return { name, price, date, rate, floor, ...(currency === undefined ? {} : { currency }) };
}
