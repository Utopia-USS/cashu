// Where a tapped notification leads (designer #22.13): alerts to Investments' Signals; the evening and
// weekly digests and the warnings to Today; a closed month to its closed screen; a device change to the
// profile sheet. The profile is switched first when the notification belongs to another one on this
// phone. Pure; the shell's hook navigates.

export type TapDestination =
  | { readonly kind: "signals" }
  | { readonly kind: "today" }
  | { readonly kind: "closed"; readonly month: string | null }
  | { readonly kind: "profile" };

export interface TapTarget {
  /** The vault to make current first; null when it is current already. */
  readonly switchTo: string | null;
  readonly destination: TapDestination;
}

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;

function destinationOf(data: Readonly<Record<string, string>>): TapDestination | null {
  switch (data.kind) {
    case "alerts_fired":
      return { kind: "signals" };
    case "evening":
    case "weekly":
    case "stale_data":
    case "consent_ending":
      return { kind: "today" };
    case "month_closed":
      return {
        kind: "closed",
        month: data.month && YEAR_MONTH.test(data.month) ? data.month : null,
      };
    case "device_change":
      return { kind: "profile" };
    default:
      return null;
  }
}

/**
 * The target of a tap on a notification carrying `data`, or null when it is not ours or names a vault
 * this phone no longer holds (removed in between).
 */
export function tapTarget(
  data: Readonly<Record<string, string>>,
  vaults: readonly string[],
  current: string | null,
): TapTarget | null {
  const vault = data.vault;
  if (vault === undefined || !vaults.includes(vault)) return null;
  const destination = destinationOf(data);
  if (destination === null) return null;
  return { switchTo: vault === current ? null : vault, destination };
}
