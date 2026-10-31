// Device settings as typed queries and device commands. Values on disk are read back through zod
// (settings on disk are a trust boundary): a value that does not decode reads as unset.
import { z } from "zod";
import { vaultId } from "../events/v1/primitives.js";
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
