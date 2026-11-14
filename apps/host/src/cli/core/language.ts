// `cashu language [pl|en|system]`: the app language of this device, the same pin as Settings > App >
// Language. One choice for the window, the backend texts and the agent (the MCP instructions name
// it), so a setup through the agent or the terminal can pick it before anything else.

import type { Lang } from "@cashu/i18n";
import { setDevicePreferences } from "@cashu/store/device";
import { runDeviceCommand } from "../../commands.js";
import { appLanguage, pinnedLanguage } from "../../language.js";
import type { HostStores } from "../../stores.js";
import { cliCommandKey } from "../commandOutcome.js";
import { N } from "../native.strings.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { C } from "./strings.js";

type Pin = "system" | Lang;

interface LanguageDeps {
  readonly stores: Pick<HostStores, "device">;
  /** Tests: the OS language a `system` pin resolves to. */
  readonly system?: () => Lang;
}

const PINS: readonly Pin[] = ["pl", "en", "system"];

function pinned(deps: LanguageDeps): Pin {
  return pinnedLanguage(deps.stores) ?? "system";
}

function resolved(deps: LanguageDeps): Lang {
  return appLanguage(deps.stores, deps.system?.());
}

function show(io: CommandIo, deps: LanguageDeps): number {
  const pin = pinned(deps);
  io.stdout(
    `${io.t.tr(C.languageCurrent)(io.t.tr(C.languageName[resolved(deps)]), pin === "system")}\n`,
  );
  return 0;
}

async function set(pin: Pin, io: CommandIo, deps: LanguageDeps): Promise<number> {
  if (io.signal.aborted) return 130;
  const device = deps.stores.device;
  const key = cliCommandKey();
  let ok: boolean;
  try {
    const run = await device.queue.run(() =>
      runDeviceCommand(device, setDevicePreferences, { languagePin: pin }, key),
    );
    ok = "ok" in run.result ? run.result.ok : run.result.kind === "completed";
  } catch {
    io.stderr(`${io.t.tr(N.commandUnknown)(setDevicePreferences.id, key)}\n`);
    return 1;
  }
  if (!ok) {
    io.stderr(`${io.t.tr(C.languageRefused)}\n`);
    return 1;
  }
  io.stdout(
    `${io.t.tr(C.languageSet)(io.t.tr(C.languageName[resolved(deps)]), pin === "system")}\n`,
  );
  return 0;
}

export function languageCommand(deps: LanguageDeps): PortedCommand {
  return {
    name: "language",
    async run(args, io: CommandIo) {
      if (args.length === 0) return show(io, deps);
      const choice = args[0]?.toLowerCase();
      if (args.length !== 1 || !PINS.includes(choice as Pin)) {
        io.stderr(`${io.t.tr(C.languageUsage)}\n`);
        return 2;
      }
      return set(choice as Pin, io, deps);
    },
  };
}
