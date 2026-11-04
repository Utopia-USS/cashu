/** Cached research inputs, validated before publication to a current native vault. */
import { createHash } from "node:crypto";
import { fromIsoFormat, parseDateTime } from "@cashu/domain";
import { Currencies } from "@cashu/domain/investments";
import * as macro from "@cashu/domain/investments/macro";
import type { SqlCalendarCache, SqlPriceCache } from "@cashu/store/investments/local";
import { z } from "zod";
import { researchScreenSources } from "../researchScreen.js";
import type { OpenVault } from "../stores.js";

export function cachedMacroCloses(prices: SqlPriceCache): macro.MacroCloses {
  const closes: Record<string, readonly macro.MacroClose[]> = {};
  for (const key of macro.SERIES_KEYS)
    closes[key] = prices.macroBars(key).map((bar) => [bar.date, Number(bar.close.toString())]);
  closes[macro.USDPLN] = prices
    .rates("nbp", Currencies.USD)
    .map((row) => [row.date, Number(row.rate.toString())]);
  return closes;
}

const date = z.string().refine((value) => {
  try {
    fromIsoFormat(value);
    return true;
  } catch {
    return false;
  }
});
const instant = z.string().refine((value) => {
  try {
    parseDateTime(value);
    return true;
  } catch {
    return false;
  }
});
const calendarSchema = z.looseObject({
  fetched_at: instant.nullable(),
  from: date,
  to: date,
  macro: z.array(
    z.looseObject({
      date,
      time: z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
        .nullable(),
      country: z.string(),
      title: z.string(),
      source_title: z.string().optional(),
    }),
  ),
  earnings: z.array(
    z.looseObject({
      date,
      symbol: z.string(),
      name: z.string(),
      when: z.enum(["pre", "after"]).nullable(),
    }),
  ),
  errors: z.array(z.string()),
});

export function calendarFeeds(bytes: Uint8Array | null) {
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const parsed = calendarSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function cachedResearchSources(input: {
  prices: SqlPriceCache;
  calendar: SqlCalendarCache;
  vaults: ReadonlyMap<string, OpenVault>;
  isCurrent(vault: OpenVault): boolean;
}) {
  const sources = researchScreenSources((id) => {
    const vault = input.vaults.get(id);
    if (vault?.mode !== "native" || !input.isCurrent(vault)) return null;
    const session = vault.native.workspaceAuthority();
    if (session?.vault !== id || !session.isCurrent()) return null;
    const bytes = input.calendar.rawBytes();
    const feeds = calendarFeeds(bytes);
    return {
      vault: id,
      generation: session.generation,
      isCurrent: () =>
        input.vaults.get(id) === vault && input.isCurrent(vault) && session.isCurrent(),
      macro: { revision: String(input.prices.version()), closes: cachedMacroCloses(input.prices) },
      ...(feeds === null || bytes === null
        ? {}
        : {
            calendar: { revision: createHash("sha256").update(bytes).digest("hex"), feeds },
          }),
    };
  });
  const stopPrices = input.prices.subscribe(() => sources.changed());
  const stopCalendar = input.calendar.subscribe(() => sources.changed());
  return {
    sources,
    close() {
      stopPrices();
      stopCalendar();
      sources.close();
    },
  };
}
