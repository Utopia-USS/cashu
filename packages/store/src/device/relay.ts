// The sync relay switch of one vault on this device (M4, the Mac host): `relay.<vaultId>` in
// device_settings, JSON. Device-local and never synced: whether this device talks to the relay for a
// vault is this device's choice. Read back through zod (a value that does not decode reads as unset).
import { z } from "zod";
import { deviceId, vaultId } from "../events/v1/primitives.js";
import { defineQuery, type Read } from "../query.js";
import { defineDeviceCommand } from "./store.js";

/** A Firebase project id (public identifier): 6 to 30 lower-case letters, digits and hyphens. */
const projectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
/** An anonymous Firebase uid. */
const uid = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const millis = z.number().int().nonnegative();

export const relaySettingSchema = z.object({
  enabled: z.boolean(),
  /** The relay project the vault was enabled on. */
  project: projectId,
  enabledAt: millis,
  /** The anonymous uid bound to each device at the relay (member documents written by this Mac). */
  memberUids: z.record(deviceId, uid),
  /** Set when this device's relay identity was replaced: the membership of its old uid is stale. */
  identityLostAt: millis.optional(),
  /**
   * G2: start of the vault's last sync pass that pulled every remote completely (the engine's
   * `PullHistory.lastCompleteAt`); bounds how long a pinned leader acts while the relay is out.
   */
  lastCompletePullAt: millis.optional(),
  /**
   * G5: start of the first pass after it that was not complete ("Sync paused since"); cleared by
   * the next complete pass.
   */
  pausedSince: millis.optional(),
});

export type RelaySetting = z.infer<typeof relaySettingSchema>;

const PREFIX = "relay.";

/** The device_settings key of a vault's relay switch. */
export const relaySettingKey = (vault: string): `relay.${string}` => `${PREFIX}${vault}`;

function decode(raw: string | undefined): RelaySetting | null {
  if (raw === undefined) return null;
  try {
    const parsed = relaySettingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readOne(read: Read, vault: string): RelaySetting | null {
  return decode(
    read<{ value: string }>(
      "SELECT value FROM device_settings WHERE key = ?",
      relaySettingKey(vault),
    )[0]?.value,
  );
}

/** One vault's relay switch, null when never enabled on this device (or unreadable). */
export const relaySetting = defineQuery({
  id: "device.relaySetting",
  scope: "device",
  run(read, args: { vault: string }): RelaySetting | null {
    return vaultId.safeParse(args.vault).success ? readOne(read, args.vault) : null;
  },
});

/** Every vault's relay switch on this device, by vault id (unreadable values left out). */
export const relaySettings = defineQuery({
  id: "device.relaySettings",
  scope: "device",
  run(read): Readonly<Record<string, RelaySetting>> {
    const out: Record<string, RelaySetting> = {};
    const rows = read<{ key: string; value: string }>(
      "SELECT key, value FROM device_settings WHERE key LIKE 'relay.%' ORDER BY key",
    );
    for (const row of rows) {
      const vault = row.key.slice(PREFIX.length);
      const setting = vaultId.safeParse(vault).success ? decode(row.value) : null;
      if (setting !== null) out[vault] = setting;
    }
    return out;
  },
});

/** Write (or with `null` clear) one vault's relay switch. */
export const setRelaySetting = defineDeviceCommand({
  id: "device.setRelaySetting",
  input: z.object({ vault: vaultId, value: relaySettingSchema.nullable() }),
  run(ctx, input) {
    ctx.setSetting(
      relaySettingKey(input.vault),
      input.value === null ? null : JSON.stringify(input.value),
    );
    return { ok: true, value: null } as const;
  },
});
