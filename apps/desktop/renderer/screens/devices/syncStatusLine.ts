// The ONE status line of Settings > Devices > Sync, chosen from the host's value-free relay status
// (`native.relay.status`), and the paused bank fetch variant. Pure: the clock and the device names (the
// live device list) are parameters.
import type { RelayStatusResult } from "@cashu/host-protocol";
import { relativeDay } from "@cashu/ui-logic/core/time";

/** A device's name from the device list; null when the list does not know it (never an id). */
export type DeviceNameOf = (device: string) => string | null;

export type SyncStatusLine =
  /** No sync config on this host: the whole row is hidden. */
  | { readonly kind: "hidden" }
  /** Sync is switched off for this profile: the switch alone says it. */
  | { readonly kind: "off" }
  /** This Mac's sync identity was replaced and a recovery secret is kept: "Reconnect sync" (#25.1). */
  | { readonly kind: "reconnect" }
  /** The identity was replaced but nothing here can re-admit this Mac. */
  | { readonly kind: "reconnect_unavailable" }
  /**
   * A removed device whose access sync has not withdrawn yet (it can still receive new data): the
   * longest failing one, by name, or null for the device-less line. Offers "Try now".
   */
  | { readonly kind: "removal_failing"; readonly device: string | null }
  | { readonly kind: "quota" }
  | { readonly kind: "paused"; readonly since: number }
  /** Changes from another device fail to read after repeated passes (#25.3); its name or null. */
  | { readonly kind: "stuck_failed"; readonly device: string | null }
  /** Changes from another device wait for something (a key, an earlier frame) (#25.3). */
  | { readonly kind: "stuck_waiting"; readonly device: string | null }
  /** The last good pass, as a clock time on its local calendar day. */
  | {
      readonly kind: "synced";
      readonly at: number;
      readonly day: "today" | "yesterday" | "earlier";
      readonly devices: number;
    }
  | { readonly kind: "first_sync"; readonly devices: number };

/**
 * Most urgent first: an identity to reconnect, a removed device that can still receive data, the
 * day's quota, a paused sync, unreadable changes, then the plain "synced" line. A stuck stream only
 * `final` (expected, never an error) shows nothing.
 */
export function syncStatusLine(
  status: RelayStatusResult,
  now: number,
  nameOf: DeviceNameOf = () => null,
): SyncStatusLine {
  if (!status.configured) return { kind: "hidden" };
  if (!status.enabled) return { kind: "off" };
  if (status.identityLost)
    return status.canReconnect ? { kind: "reconnect" } : { kind: "reconnect_unavailable" };
  if (status.removalsFailing !== undefined) {
    const oldest = status.removalsFailing.ids[0];
    return { kind: "removal_failing", device: oldest === undefined ? null : nameOf(oldest) };
  }
  if (status.quotaUntil !== undefined && status.quotaUntil > now) return { kind: "quota" };
  if (status.pausedSince !== undefined) return { kind: "paused", since: status.pausedSince };
  const stuckDevice = status.stuck?.device === undefined ? null : nameOf(status.stuck.device);
  if (status.stuck !== undefined && status.stuck.rejected > 0)
    return { kind: "stuck_failed", device: stuckDevice };
  if (status.stuck !== undefined && status.stuck.waiting > 0)
    return { kind: "stuck_waiting", device: stuckDevice };
  if (status.lastSyncAt === undefined) return { kind: "first_sync", devices: status.devices };
  return {
    kind: "synced",
    at: status.lastSyncAt,
    day: relativeDay(new Date(status.lastSyncAt), new Date(now)),
    devices: status.devices,
  };
}

/**
 * Which "Bank fetch paused" text the Devices screen shows for a pinned leader the host reports as
 * paused (`leader.paused: "offline_too_long"`): the outage variant while sync is on, the sync-off
 * variant when sync is off or this host has no sync at all. Null when nothing is paused.
 */
export function fetchPausedLine(
  paused: "offline_too_long" | undefined,
  status: RelayStatusResult | null,
): "outage" | "sync_off" | null {
  if (paused === undefined) return null;
  return status?.configured === true && status.enabled ? "outage" : "sync_off";
}
