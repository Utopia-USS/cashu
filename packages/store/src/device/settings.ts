// Device settings as typed queries and device commands. Values on disk are read back through zod
// (settings on disk are a trust boundary): a value that does not decode reads as unset.
import {
  DEFAULT_NOTIFICATION_PREFS,
  EMPTY_NOTIFICATION_LEDGER,
  type NotificationLedger,
  type NotificationPrefs,
} from "@cashu/domain/core/notifications";
import { z } from "zod";
import { calendarDate, gid, timestamp, vaultId } from "../events/v1/primitives.js";
import { defineQuery, type Read } from "../query.js";
import { type DeviceSettingKey, defineDeviceCommand } from "./store.js";

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

/** One JSON record of per-vault values under one setting key; undecodable reads as empty. */
function readVaultRecord<T>(
  read: Read,
  key: DeviceSettingKey,
  schema: z.ZodType<Record<string, T>>,
): Record<string, T> {
  const raw = setting(read, key);
  if (raw === null) return {};
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The editable notification choices; `deviceChanges` is always on and not settable. */
const notificationPrefsPatch = z.object({
  alertsFired: z.boolean().optional(),
  weekly: z.boolean().optional(),
  monthClosed: z.boolean().optional(),
  evening: z.boolean().optional(),
  staleData: z.boolean().optional(),
  consentEnding: z.boolean().optional(),
});
/** Per vault, only the choices the user made: the defaults fill the rest when read. */
const storedNotificationPrefs = z.record(vaultId, notificationPrefsPatch);

function effectivePrefs(
  stored: z.infer<typeof notificationPrefsPatch> | undefined,
): NotificationPrefs {
  const set = Object.fromEntries(Object.entries(stored ?? {}).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_NOTIFICATION_PREFS, ...set, deviceChanges: true };
}

/** The notification choices for one vault on this phone (defaults for what the user never set). */
export const notificationPrefs = defineQuery({
  id: "device.notificationPrefs",
  scope: "device",
  run(read, args: { vault: string }): NotificationPrefs {
    return effectivePrefs(
      readVaultRecord(read, "notificationPrefs", storedNotificationPrefs)[args.vault],
    );
  },
});

/** Change some notification choices of one vault; writes only when the effective choices change. */
export const setNotificationPrefs = defineDeviceCommand({
  id: "device.setNotificationPrefs",
  input: z.object({ vault: vaultId, prefs: notificationPrefsPatch.strict() }),
  run(ctx, input) {
    const all = readVaultRecord(ctx.read, "notificationPrefs", storedNotificationPrefs);
    const before = all[input.vault];
    const after = { ...before, ...input.prefs };
    const changed = (Object.keys(input.prefs) as (keyof typeof input.prefs)[]).some(
      (k) => effectivePrefs(before)[k] !== effectivePrefs(after)[k],
    );
    if (changed)
      ctx.setSetting("notificationPrefs", JSON.stringify({ ...all, [input.vault]: after }));
    return { ok: true, value: null } as const;
  },
});

const rung = z.number().int().nonnegative().nullable();
const notificationLedgerSchema = z.object({
  lastPlannedAt: timestamp.nullable(),
  alertsSentOn: z.record(calendarDate, z.number().int().nonnegative()),
  // Signal gid -> the day a plan first saw it; ledgers written before it existed read as empty.
  notifiedAlerts: z.record(gid, calendarDate).default({}),
  staleRung: rung,
  consentRung: rung,
  monthClosedSentFor: closedMonth.nullable(),
  weeklySentFor: calendarDate.nullable(),
  eveningSentFor: calendarDate.nullable(),
});
const storedLedgers = z.record(vaultId, notificationLedgerSchema);

/** What the notification planner already sent for one vault (empty before its first run). */
export const notificationLedger = defineQuery({
  id: "device.notificationLedger",
  scope: "device",
  run(read, args: { vault: string }): NotificationLedger {
    return (
      readVaultRecord(read, "notificationLedger", storedLedgers)[args.vault] ??
      EMPTY_NOTIFICATION_LEDGER
    );
  },
});

/** Replace one vault's ledger (the planner, after scheduling succeeded); writes only on change. */
export const setNotificationLedger = defineDeviceCommand({
  id: "device.setNotificationLedger",
  input: z.object({ vault: vaultId, ledger: notificationLedgerSchema }),
  run(ctx, input) {
    const all = readVaultRecord(ctx.read, "notificationLedger", storedLedgers);
    const before = all[input.vault];
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(input.ledger))
      ctx.setSetting("notificationLedger", JSON.stringify({ ...all, [input.vault]: input.ledger }));
    return { ok: true, value: null } as const;
  },
});

const storedMarkedAlerts = z.record(vaultId, z.array(gid));

/** The alerts of one vault marked "tell my phone" on this phone, as alert gids (sorted). */
export const markedAlerts = defineQuery({
  id: "device.markedAlerts",
  scope: "device",
  run(read, args: { vault: string }): readonly string[] {
    return readVaultRecord(read, "markedAlerts", storedMarkedAlerts)[args.vault] ?? [];
  },
});

/** Mark or unmark one alert of one vault; writes only on change. */
export const setAlertMarked = defineDeviceCommand({
  id: "device.setAlertMarked",
  input: z.object({ vault: vaultId, alert: gid, marked: z.boolean() }),
  run(ctx, input) {
    const all = readVaultRecord(ctx.read, "markedAlerts", storedMarkedAlerts);
    const before = all[input.vault] ?? [];
    if (before.includes(input.alert) === input.marked) return { ok: true, value: null } as const;
    const after = input.marked
      ? [...before, input.alert].sort()
      : before.filter((a) => a !== input.alert);
    const { [input.vault]: _, ...others } = all;
    ctx.setSetting(
      "markedAlerts",
      JSON.stringify(after.length === 0 ? others : { ...others, [input.vault]: after }),
    );
    return { ok: true, value: null } as const;
  },
});

const lockFlag = z.enum(["1", "0"]);

/** Whether the app locks behind Face ID on this phone (device-wide); null before the user chose. */
export const deviceLock = defineQuery({
  id: "device.lock",
  scope: "device",
  run(read): { readonly appLock: boolean | null } {
    const flag = lockFlag.safeParse(setting(read, "appLock"));
    return { appLock: flag.success ? flag.data === "1" : null };
  },
});

export const setDeviceLock = defineDeviceCommand({
  id: "device.setLock",
  input: z.object({ appLock: z.boolean() }),
  run(ctx, input) {
    const value = input.appLock ? "1" : "0";
    if (setting(ctx.read, "appLock") !== value) ctx.setSetting("appLock", value);
    return { ok: true, value: null } as const;
  },
});
