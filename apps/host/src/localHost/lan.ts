// The bounded LAN pairing listener, started on demand (a pairing request) or at start when a vault
// already has a completed trusted pairing. Never in safe mode or a synthetic harness. The default
// port is the app flavor's (prod 8517), so a prod and a staging host on one Mac can both listen.

import { processFlavor } from "@cashu/node-host/flavor";
import { errorName, type HostLog } from "../log.js";
import { type LanPairingService, localLanIp, startLanPairingService } from "../pairing/service.js";
import type { HostStores } from "../stores.js";
import type { LocalHostOptions } from "./options.js";

export interface LanServing {
  /** The listener, once it was actually bound. */
  current(): LanPairingService | undefined;
  /** Starts the listener (once; concurrent callers share the start). */
  ensure(): Promise<LanPairingService | undefined>;
  /**
   * A completed trusted LAN pairing is the persisted serving opt-in. An unresolved append also
   * keeps the listener available for exact proof and same-device receipt retrieval.
   */
  resumeIfPaired(): Promise<void>;
  pending(): number;
  /** Waits for a start in flight, then closes the listener. */
  close(): Promise<void>;
}

export function createLanServing(input: {
  readonly option: LocalHostOptions["lan"];
  readonly nativeMode: boolean;
  readonly safeMode: boolean;
  readonly dataDir: string;
  readonly stores: HostStores;
  readonly now: () => number;
  readonly log: HostLog;
  readonly stopRequested: () => boolean;
  /** Called once the listener is bound (it re-arms the idle timer). */
  readonly onStarted: () => void;
}): LanServing {
  const { stores, log } = input;
  const option =
    input.option?.kind === "loopback" || input.option?.kind === "local" ? input.option : undefined;
  let lan: LanPairingService | undefined;
  let lanStart: Promise<LanPairingService | undefined> | undefined;
  const ensure = (): Promise<LanPairingService | undefined> => {
    if (lan !== undefined) return Promise.resolve(lan);
    if (lanStart !== undefined) return lanStart;
    if (!input.nativeMode || option === undefined || input.safeMode)
      return Promise.resolve(undefined);
    lanStart = (async () => {
      const ip = option.kind === "loopback" ? "127.0.0.1" : localLanIp();
      if (ip === undefined) return undefined;
      try {
        const service = await startLanPairingService({
          dataDir: input.dataDir,
          ip,
          port: option.port ?? (option.kind === "loopback" ? 0 : processFlavor().lanPairingPort),
          vault: (id) => stores.vaults.get(id)?.native,
          now: input.now,
        });
        if (input.stopRequested()) {
          await service.close();
          return undefined;
        }
        lan = service;
        input.onStarted();
        return service;
      } catch (error) {
        log.warn("host.lan-unavailable", { error: errorName(error) });
        return undefined;
      }
    })().finally(() => {
      lanStart = undefined;
    });
    return lanStart;
  };
  return {
    current: () => lan,
    ensure,
    async resumeIfPaired() {
      if (!input.nativeMode || option === undefined || input.safeMode) return;
      const paired = await Promise.all(
        [...stores.vaults.values()].map(
          (opened) => opened.native?.pairingHasActive() ?? Promise.resolve(false),
        ),
      );
      if (paired.some(Boolean)) await ensure();
    },
    pending: () => lan?.pending() ?? 0,
    async close() {
      await lanStart;
      await lan?.close();
    },
  };
}
