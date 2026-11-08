/**
 * The app language the owner reads cashU in, for host work that writes or instructs on the owner's
 * behalf (market labels, worker texts, CLI output, the MCP instructions): the pin from Settings or
 * `cashu language` (device store `languagePin`), else the OS language list the window follows
 * (macOS `AppleLanguages` first, then the locale variables), else English.
 */

import { type Lang, parseLang } from "@cashu/i18n";
import { nodeLanguageSource } from "@cashu/node-host";
import { devicePreferences } from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import type { HostStores } from "./stores.js";

let processSystem: Lang | undefined;

/**
 * The OS language as an app language: the first Polish or English entry, else English. Read once per
 * process for the host's own environment (it spawns `defaults` on macOS).
 */
export function systemLanguage(env?: Readonly<Record<string, string | undefined>>): Lang {
  const read = (from: Readonly<Record<string, string | undefined>>) =>
    parseLang(nodeLanguageSource({ env: from, dataDir: undefined }).osLanguage()) ?? "en";
  if (env !== undefined) return read(env);
  processSystem ??= read(process.env);
  return processSystem;
}

/** The pinned language of this device (Settings or `cashu language`), null for `system` or none. */
export function pinnedLanguage(stores: Pick<HostStores, "device">): Lang | null {
  try {
    const pin = runQuery(stores.device.store, devicePreferences, undefined).value.languagePin;
    return pin === "pl" || pin === "en" ? pin : null;
  } catch {
    return null;
  }
}

/** The app language of this data dir: the pin, else `system`. */
export function appLanguage(stores: Pick<HostStores, "device">, system?: Lang): Lang {
  return pinnedLanguage(stores) ?? system ?? systemLanguage();
}
