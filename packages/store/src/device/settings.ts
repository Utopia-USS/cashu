// Device settings as typed queries and device commands. Values on disk are read back through zod
// (settings on disk are a trust boundary): a value that does not decode reads as unset.
import { z } from "zod";
import { timestamp, vaultId } from "../events/v1/primitives.js";
import { defineQuery, type Read } from "../query.js";
import { defineDeviceCommand } from "./store.js";

function setting(read: Read, key: string): string | null {
  return (
    read<{ value: string }>("SELECT value FROM device_settings WHERE key = ?", key)[0]?.value ??
    null
  );
}

/** The vault (profile) this device shows, or null before the user picked one. */
export const currentVault = defineQuery({
  id: "device.currentVault",
  scope: "device",
  run(read): string | null {
    const parsed = vaultId.safeParse(setting(read, "currentVault"));
    return parsed.success ? parsed.data : null;
  },
});

/** Switch the current profile (null: none, e.g. after removing the last vault from this device). */
export const setCurrentVault = defineDeviceCommand({
  id: "device.setCurrentVault",
  input: z.object({ vault: vaultId.nullable() }),
  run(ctx, input) {
    ctx.setSetting("currentVault", input.vault);
    return { ok: true, value: null } as const;
  },
});

const languagePin = z.enum(["system", "pl", "en"]);
const theme = z.enum(["system", "light", "dark"]);

/** Local UI preferences; null means an older installation has not saved that choice yet. */
export const devicePreferences = defineQuery({
  id: "device.preferences",
  scope: "device",
  run(read): {
    readonly languagePin: z.infer<typeof languagePin> | null;
    readonly theme: z.infer<typeof theme> | null;
  } {
    const language = languagePin.safeParse(setting(read, "languagePin"));
    const appearance = theme.safeParse(setting(read, "theme"));
    return {
      languagePin: language.success ? language.data : null,
      theme: appearance.success ? appearance.data : null,
    };
  },
});

export const setDevicePreferences = defineDeviceCommand({
  id: "device.setPreferences",
  input: z.object({
    languagePin: languagePin.optional(),
    theme: theme.optional(),
  }),
  run(ctx, input) {
    for (const [key, value] of [
      ["languagePin", input.languagePin],
      ["theme", input.theme],
    ] as const) {
      if (value === undefined) continue;
      if (setting(ctx.read, key) !== value) ctx.setSetting(key, value);
    }
    return { ok: true, value: null } as const;
  },
});

const incognitoFlag = z.enum(["1", "0"]);

/** Phone state kept on this device: incognito (money hidden) and when the app was last opened. */
export const devicePhoneState = defineQuery({
  id: "device.phoneState",
  scope: "device",
  run(read): {
    readonly incognito: boolean;
    readonly lastOpenedAt: string | null;
  } {
    const incognito = incognitoFlag.safeParse(setting(read, "incognito"));
    const opened = timestamp.safeParse(setting(read, "lastOpenedAt"));
    return {
      incognito: incognito.success && incognito.data === "1",
      lastOpenedAt: opened.success ? opened.data : null,
    };
  },
});

/** Change only the given fields; `lastOpenedAt: null` clears it. */
export const setDevicePhoneState = defineDeviceCommand({
  id: "device.setPhoneState",
  input: z.object({
    incognito: z.boolean().optional(),
    lastOpenedAt: timestamp.nullable().optional(),
  }),
  run(ctx, input) {
    if (input.incognito !== undefined) {
      const value = input.incognito ? "1" : "0";
      if (setting(ctx.read, "incognito") !== value) ctx.setSetting("incognito", value);
    }
    const opened = input.lastOpenedAt;
    if (opened !== undefined && setting(ctx.read, "lastOpenedAt") !== opened)
      ctx.setSetting("lastOpenedAt", opened);
    return { ok: true, value: null } as const;
  },
});

/** A closed month, "YYYY-MM". */
const closedMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
/** One put-away month per vault: a profile's choice never shows up in another profile (rule 7). */
const closedMonths = z.record(vaultId, closedMonth);

function readClosedMonths(read: Read): Record<string, string> {
  const raw = setting(read, "monthClosedSeen");
  if (raw === null) return {};
  try {
    const parsed = closedMonths.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * The closed month whose month-closed state the owner put away on this device for one vault ("Show
 * the running month"); the state shows again only for a later closed month. Null when none was put away.
 */
export const monthClosedSeen = defineQuery({
  id: "device.monthClosedSeen",
  scope: "device",
  run(read, args: { vault: string }): string | null {
    return readClosedMonths(read)[args.vault] ?? null;
  },
});

export const setMonthClosedSeen = defineDeviceCommand({
  id: "device.setMonthClosedSeen",
  input: z.object({ vault: vaultId, month: closedMonth }),
  run(ctx, input) {
    const months = readClosedMonths(ctx.read);
    if (months[input.vault] !== input.month) {
      ctx.setSetting("monthClosedSeen", JSON.stringify({ ...months, [input.vault]: input.month }));
    }
    return { ok: true, value: null } as const;
  },
});

/** When this phone last fetched market prices itself, per vault: a run fetches only that vault's tickers. */
const fetchTimes = z.record(vaultId, timestamp);

function readFetchTimes(read: Read): Record<string, string> {
  const raw = setting(read, "pricesFetchedAt");
  if (raw === null) return {};
  try {
    const parsed = fetchTimes.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * When this phone last fetched the market prices of one vault itself (the Investments header's "fetched
 * by this phone"); null when it never did. Another vault's fetch never shows here (rule 7).
 */
export const pricesFetchedAt = defineQuery({
  id: "device.pricesFetchedAt",
  scope: "device",
  run(read, args: { vault: string }): string | null {
    return readFetchTimes(read)[args.vault] ?? null;
  },
});

export const setPricesFetchedAt = defineDeviceCommand({
  id: "device.setPricesFetchedAt",
  input: z.object({ vault: vaultId, at: timestamp }),
  run(ctx, input) {
    const times = readFetchTimes(ctx.read);
    if (times[input.vault] !== input.at) {
      ctx.setSetting("pricesFetchedAt", JSON.stringify({ ...times, [input.vault]: input.at }));
    }
    return { ok: true, value: null } as const;
  },
});
