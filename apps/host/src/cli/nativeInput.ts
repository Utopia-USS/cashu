import { D, floatRepr, fromIsoFormat } from "@cashu/domain";

export type Parsed = { readonly args: string[]; readonly options: Map<string, string> };

/** Small strict native parser: no Python fallthrough or implicit terminal prompts. */
export function parse(args: readonly string[], values: readonly string[]): Parsed | null {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (!ended && word === "--") {
      ended = true;
      continue;
    }
    if (!ended && word.startsWith("-")) {
      const equal = word.indexOf("=");
      const key = equal < 0 ? word : word.slice(0, equal);
      if (!values.includes(key) || options.has(key)) return null;
      const value = equal < 0 ? args[++i] : word.slice(equal + 1);
      if (value === undefined) return null;
      options.set(key, value);
    } else positional.push(word);
  }
  return { args: positional, options };
}

export function decimal(raw: string | undefined): string | null {
  if (raw === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))
    return null;
  const value = Number(raw);
  // Frozen Typer CLI parses these arguments as Python float before Decimal(str(value)).
  return Number.isFinite(value) ? D(floatRepr(value)).format("f") : null;
}

export function date(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    return fromIsoFormat(raw);
  } catch {
    return null;
  }
}

export function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
