import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { SqlDriver } from "../../sql/driver.js";
import type { GenesisVault } from "../index.js";
import { dumps, type OutValue, text, timestamp } from "./canonical.js";

type Row = Readonly<Record<string, unknown>>;

export class DeviceLocalSourceError extends Error {
  constructor() {
    super("device_local_source_mismatch");
    this.name = "DeviceLocalSourceError";
  }
}

function sourceId(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new DeviceLocalSourceError();
  }
  return String(value);
}

function requiredText(value: unknown): string {
  const normalized = text(value);
  if (normalized === null) throw new DeviceLocalSourceError();
  return normalized;
}

function requiredTimestamp(value: unknown): string {
  const normalized = timestamp(value);
  if (normalized === null) throw new DeviceLocalSourceError();
  return normalized;
}

function digest(value: OutValue): string {
  return bytesToHex(sha256(new TextEncoder().encode(dumps(value))));
}

/**
 * Re-read the frozen source, independent of the exporter, and compare every device-local field
 * that genesis carries outside the synced event log. The caller still must durably persist and
 * independently reopen the device database before publishing the native inventory.
 */
export function verifyDeviceLocalSource(
  driver: SqlDriver,
  vault: GenesisVault,
): { readonly notifications: number; readonly connectorFetch: number; readonly digest: string } {
  const signalMap = new Map(
    vault.ids
      .filter((entry) => entry.table === "inv_signals")
      .map((entry) => [entry.localId, entry.gid]),
  );
  const bindingEntries = vault.ids.filter((entry) => entry.table === "connector_bindings");
  const bindingMap = new Map(bindingEntries.map((entry) => [entry.localId, entry.gid]));
  if (signalMap.size !== vault.ids.filter((entry) => entry.table === "inv_signals").length) {
    throw new DeviceLocalSourceError();
  }
  const notifications = driver
    .prepare(
      `SELECT n.*, s.profile_id AS signal_profile_id FROM inv_notification_log n
       LEFT JOIN inv_signals s ON s.id=n.signal_id WHERE n.profile_id=? ORDER BY n.id`,
    )
    .all<Row>(vault.profileId)
    .map((row) => {
      if (row.signal_profile_id !== vault.profileId) throw new DeviceLocalSourceError();
      const signal = signalMap.get(sourceId(row.signal_id));
      if (!signal) throw new DeviceLocalSourceError();
      return {
        signal,
        severity: requiredText(row.severity),
        createdAt: requiredTimestamp(row.created_at),
        sentAt: timestamp(row.sent_at),
        channel: text(row.channel),
      };
    });
  const bindings = driver
    .prepare(
      `SELECT b.*, a.profile_id AS account_profile_id FROM connector_bindings b
       LEFT JOIN accounts a ON a.id=b.account_id WHERE b.profile_id=? ORDER BY b.id`,
    )
    .all<Row>(vault.profileId);
  if (bindingMap.size !== bindingEntries.length || bindingMap.size !== bindings.length) {
    throw new DeviceLocalSourceError();
  }
  const connectorFetch = bindings.map((row) => {
    if (row.account_profile_id !== vault.profileId) throw new DeviceLocalSourceError();
    const binding = bindingMap.get(sourceId(row.id));
    if (!binding) throw new DeviceLocalSourceError();
    return {
      binding,
      lastRunAt: timestamp(row.last_run_at),
      lastStatus: text(row.last_status),
      lastOkAt: timestamp(row.last_ok_at),
      backoffUntil: timestamp(row.backoff_until),
    };
  });
  const actualNotifications = vault.deviceLocal.notifications.map((row) => ({
    signal: requiredText(row.signal),
    severity: requiredText(row.severity),
    createdAt: requiredTimestamp(row.createdAt),
    sentAt: timestamp(row.sentAt),
    channel: text(row.channel),
  }));
  const actualFetch = vault.deviceLocal.connectorFetch.map((row) => ({
    binding: requiredText(row.binding),
    lastRunAt: timestamp(row.lastRunAt),
    lastStatus: text(row.lastStatus),
    lastOkAt: timestamp(row.lastOkAt),
    backoffUntil: timestamp(row.backoffUntil),
  }));
  if (
    notifications.length !== actualNotifications.length ||
    connectorFetch.length !== actualFetch.length ||
    digest(notifications) !== digest(actualNotifications) ||
    digest(connectorFetch) !== digest(actualFetch)
  ) {
    throw new DeviceLocalSourceError();
  }
  return {
    notifications: notifications.length,
    connectorFetch: connectorFetch.length,
    digest: digest([notifications, connectorFetch]),
  };
}
