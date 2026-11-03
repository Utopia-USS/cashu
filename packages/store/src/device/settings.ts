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

const languagePin = z.enum(["system", "pl", "en"]);
const theme = z.enum(["system", "light", "dark"]);

/** Local UI preferences; null means an older installation has not saved that choice yet. */
export const devicePreferences = defineQuery({
  id: "device.preferences",
  scope: "device",
  run(read): {
    readonly languagePin: z.infer<typeof languagePin> | null;
    readonly theme: z.infer<typeof theme> | null;
    readonly updatesAuto: boolean | null;
  } {
    const language = languagePin.safeParse(setting(read, "languagePin"));
    const appearance = theme.safeParse(setting(read, "theme"));
    const updates = setting(read, "updatesAuto");
    return {
      languagePin: language.success ? language.data : null,
      theme: appearance.success ? appearance.data : null,
      updatesAuto: updates === "1" ? true : updates === "0" ? false : null,
    };
  },
});

export const setDevicePreferences = defineDeviceCommand({
  id: "device.setPreferences",
  input: z.object({
    languagePin: languagePin.optional(),
    theme: theme.optional(),
    updatesAuto: z.boolean().optional(),
  }),
  run(ctx, input) {
    for (const [key, value] of [
      ["languagePin", input.languagePin],
      ["theme", input.theme],
      ["updatesAuto", input.updatesAuto === undefined ? undefined : input.updatesAuto ? "1" : "0"],
    ] as const) {
      if (value === undefined) continue;
      if (setting(ctx.read, key) !== value) ctx.setSetting(key, value);
    }
    return { ok: true, value: null } as const;
  },
});
