/**
 * The app language the owner reads cashU in, for host work that writes or instructs on the owner's
 * behalf (market labels, worker texts, the MCP instructions): the pin from Settings (device store
 * `languagePin`), else the OS locale, the same rule the window follows.
 */

import type { Lang } from "@cashu/i18n";
import { devicePreferences } from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import type { HostStores } from "./stores.js";

/** The OS locale as an app language: Polish for a `pl*` locale, else English. */
export function systemLanguage(): Lang {
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("pl")
    ? "pl"
    : "en";
}

/** The pinned app language of this data dir, else `system`. */
export function appLanguage(stores: HostStores, system: Lang = systemLanguage()): Lang {
  try {
    const pinned = runQuery(stores.device.store, devicePreferences, undefined).value.languagePin;
    return pinned === "pl" || pinned === "en" ? pinned : system;
  } catch {
    return system;
  }
}
