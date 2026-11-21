// Settings > Devices: one row per device of the profile, every fact on its own row (designer spec
// devices-v1, variant 1). Pure: the device list, today's local calendar day and the fetch rule come in
// as parameters; the View renders the words through Devices.strings.ts.
import type { DeviceListResult } from "@cashu/host-protocol";
import { addDays } from "@cashu/ui-logic/core/time";

type Ready = Extract<DeviceListResult, { kind: "ready" }>;

/**
 * The fetch lease's offline bound in days (sync lease.ts OFFLINE_LEAD_MAX_MS, 7 days): the device list
 * does not carry it, so the paused-fetch texts take it from here.
 */
export const OFFLINE_BOUND_DAYS = 7;

/** The all-zero issuer: a device added with the 24 recovery words, not by another device. */
const RECOVERY_ISSUER = "0".repeat(32);

/** A calendar day in words: today, yesterday, or the date (its year only outside the current one). */
export type DayWord =
  | { readonly kind: "today" }
  | { readonly kind: "yesterday" }
  | { readonly kind: "date"; readonly iso: string; readonly sameYear: boolean };

function dayWord(iso: string, today: string): DayWord {
  // A day ahead of this clock (another device's, or a clock that went back) still reads as today.
  if (iso >= today) return { kind: "today" };
  if (iso === addDays(today, -1)) return { kind: "yesterday" };
  return { kind: "date", iso, sameYear: iso.slice(0, 4) === today.slice(0, 4) };
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
/** "4 Nov" / "4 lis", with the year outside the current one ("4 Nov 2025"); calendar day at UTC noon. */
export function dateText(day: Extract<DayWord, { kind: "date" }>, language: "pl" | "en"): string {
  const key = `${language}:${day.sameYear}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(language === "pl" ? "pl-PL" : "en-GB", {
      day: "numeric",
      month: "short",
      ...(day.sameYear ? {} : { year: "numeric" }),
      timeZone: "UTC",
    });
    dateFormats.set(key, format);
  }
  return format.format(new Date(`${day.iso}T12:00:00Z`));
}

type DeviceOrigin =
  /** The profile's first device: it added itself. */
  | { readonly kind: "first" }
  | { readonly kind: "recovery" }
  | { readonly kind: "device"; readonly by: string }
  /** Added by a device the list does not name (never an id). */
  | { readonly kind: "unnamed" };

export interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly thisMac: boolean;
  /**
   * The pinned device that fetches the bank data ("Fetches bank data"), shown without a time: the host's
   * `lastActivityAt` cannot tell a fetch from the pin (designer, 2026-11-21).
   */
  readonly fetches: boolean;
  /** This Mac fetches and its bank fetch is paused by the offline bound: "Fetch paused" instead. */
  readonly fetchPaused: boolean;
  readonly origin: DeviceOrigin;
  readonly addedOn: DayWord | null;
  /** The day the device said it removed its own copy (still a device of the profile). */
  readonly removedCopyOn: DayWord | null;
  readonly behind: boolean;
  readonly forked: boolean;
  /**
   * The row menu's "Fetch bank data on this Mac", on this Mac's row only (fetching moves to another Mac
   * from that Mac); disabled before the 36-hour rule allows a change. Null: not offered (another device,
   * mode auto, this Mac already fetches).
   */
  readonly fetchItem: { readonly enabled: boolean } | null;
  /**
   * "Remove from profile…" in the row menu: every trusted device but this Mac and a device that removed
   * its copy (its note's button removes it; no row menu then).
   */
  readonly removable: boolean;
}

/**
 * The rows, this Mac first, then by the order the devices were added. Revoked devices are gone from the profile and have no row.
 * `fetchChangeAllowed` is today's rule for the change of the fetching device (the leader warning after
 * 36 hours without a fetch, and no paused fetch on this Mac).
 */
export function deviceRows(
  list: Ready,
  today: string,
  fetchChangeAllowed: boolean,
): readonly DeviceRow[] {
  const names = new Map(list.devices.map((device) => [device.id, device.name]));
  const added = new Map(
    [...list.devices]
      .sort(
        (a, b) =>
          a.pairedAt.seg - b.pairedAt.seg ||
          a.pairedAt.offset - b.pairedAt.offset ||
          a.id.localeCompare(b.id),
      )
      .map((device, index) => [device.id, index]),
  );
  const leader = list.leader;
  const fetching =
    leader.mode === "pinned" && (leader.state === "ok" || leader.state === "silent")
      ? leader.device
      : null;
  return list.devices
    .filter((device) => !device.revoked)
    .map((device): DeviceRow => {
      const thisMac = device.id === list.ownDevice;
      const left = device.leftAt !== undefined && device.trusted && !thisMac;
      const by = names.get(device.pairedBy);
      const pinnable = thisMac && leader.mode === "pinned" && device.id !== leader.device;
      return {
        id: device.id,
        name: device.name,
        thisMac,
        fetches: device.id === fetching && list.leader.paused === undefined,
        fetchPaused: device.id === fetching && list.leader.paused !== undefined,
        origin:
          device.pairedBy === device.id
            ? { kind: "first" }
            : device.pairedBy === RECOVERY_ISSUER
              ? { kind: "recovery" }
              : by === undefined
                ? { kind: "unnamed" }
                : { kind: "device", by },
        addedOn: device.pairedOn === undefined ? null : dayWord(device.pairedOn, today),
        removedCopyOn: left && device.leftAt !== undefined ? dayWord(device.leftAt, today) : null,
        behind: device.behind && !device.forked,
        forked: device.forked,
        fetchItem: pinnable ? { enabled: fetchChangeAllowed } : null,
        removable: !thisMac && device.trusted && !left,
      };
    })
    .sort(
      (a, b) =>
        Number(b.thisMac) - Number(a.thisMac) || (added.get(a.id) ?? 0) - (added.get(b.id) ?? 0),
    );
}

/**
 * The device that fetches today (or must still hand over), by name, and its silence in whole days (0
 * under a day: the force text then names no duration); null when none is named.
 */
export function currentFetcher(
  list: Ready,
): { readonly name: string; readonly days: number } | null {
  if (list.leader.mode !== "pinned") return null;
  const id = list.leader.pendingFrom ?? list.leader.device;
  const name = list.devices.find((device) => device.id === id)?.name;
  if (name === undefined) return null;
  return { name, days: Math.floor(list.leader.silentForMs / 86_400_000) };
}
