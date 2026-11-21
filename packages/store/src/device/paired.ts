// The vaults this phone was paired into (the device setting `pairedVaults`): the inventory the phone's
// services open at boot, one entry per vault. Only public facts live here; the device identity and the
// keyring sit in the KeyStore, the certificates and key provenance in the vault's own log database.
import { z } from "zod";
import { deviceId, vaultId } from "../events/v1/primitives.js";
import { defineQuery, type Read } from "../query.js";
import { defineDeviceCommand } from "./store.js";

const role = z.enum(["owner", "partner"]);

const pairedVault = z.object({
  vaultId,
  /** This phone's device id in that vault (its identity in the KeyStore). */
  deviceId,
  /** Whose phone this is for that profile, chosen on the phone (changeable later). */
  role,
  /** Epoch ms of the pairing. */
  pairedAt: z.number().int().nonnegative(),
  /** The profile's name as last known (the first sync replaces the placeholder). */
  name: z.string().min(1).max(200),
});

export type PairedVault = z.infer<typeof pairedVault>;

/**
 * The stored list as read: every element in order (`raw`, kept byte for byte on the next save) and the
 * ones that decode (`entries`). `corrupt` when the value is not a JSON array at all: nothing decodes,
 * and a save would overwrite what may still be repaired, so writes refuse (`paired_vaults_corrupt`).
 */
interface StoredList {
  readonly raw: readonly unknown[];
  readonly entries: readonly PairedVault[];
  readonly corrupt: boolean;
}

function readStored(read: Read): StoredList {
  const value =
    read<{ value: string }>("SELECT value FROM device_settings WHERE key = 'pairedVaults'")[0]
      ?.value ?? null;
  if (value === null) return { raw: [], entries: [], corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { raw: [], entries: [], corrupt: true };
  }
  if (!Array.isArray(parsed)) return { raw: [], entries: [], corrupt: true };
  // Per entry: one value a later version writes (a new role) or a flipped byte drops that entry
  // alone, never the other vaults.
  const entries = parsed.flatMap((element) => {
    const entry = pairedVault.safeParse(element);
    return entry.success ? [entry.data] : [];
  });
  return { raw: parsed, entries, corrupt: false };
}

/** The vault id an element names, decodable or not (a damaged entry is replaced by its own vault). */
function vaultOf(element: unknown): unknown {
  return typeof element === "object" && element !== null
    ? (element as { vaultId?: unknown }).vaultId
    : undefined;
}

/**
 * The vaults paired into this phone, in pairing order. An entry that does not decode is left out (its
 * raw value stays stored); a value that is not a list reads as none.
 */
export const pairedVaults = defineQuery({
  id: "device.pairedVaults",
  scope: "device",
  run(read): readonly PairedVault[] {
    return readStored(read).entries;
  },
});

/**
 * Add a paired vault, or replace the entry of the same vault (a re-pairing, a role or name change).
 * Entries of other vaults are kept as stored, decodable or not.
 */
export const savePairedVault = defineDeviceCommand({
  id: "device.savePairedVault",
  input: pairedVault,
  run(ctx, input) {
    const stored = readStored(ctx.read);
    if (stored.corrupt) return { ok: false, reason: "paired_vaults_corrupt" } as const;
    const at = stored.raw.findIndex((element) => vaultOf(element) === input.vaultId);
    const next =
      at < 0
        ? [...stored.raw, input]
        : stored.raw.map((element, i) => (i === at ? input : element));
    ctx.setSetting("pairedVaults", JSON.stringify(next));
    return { ok: true, value: null } as const;
  },
});

/** Drop one vault from this phone's inventory (its files and keys are the caller's to delete). */
export const forgetPairedVault = defineDeviceCommand({
  id: "device.forgetPairedVault",
  input: z.object({ vaultId }),
  run(ctx, input) {
    const stored = readStored(ctx.read);
    if (stored.corrupt) return { ok: false, reason: "paired_vaults_corrupt" } as const;
    const all = stored.raw;
    const next = all.filter((element) => vaultOf(element) !== input.vaultId);
    if (next.length !== all.length) {
      ctx.setSetting("pairedVaults", next.length === 0 ? null : JSON.stringify(next));
    }
    return { ok: true, value: null } as const;
  },
});
