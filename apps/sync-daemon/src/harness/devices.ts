// TRANSITIONAL(S49): the S31a milestone harness (spec 9.3 steps 6 and 8).
//
// Devices of the harness process besides the daemon: an inbound device that writes allowed edits into
// a vault (spec 9.3 step 6) and the verifier, a fresh device with an empty store that pulls only the
// encrypted remote folder and folds it (step 8; never the daemon's state dir). Each gets its own
// device identity and the vault ring from the lab key store.
//
// Deviation (S31a checkpoint): the ring is loaded from the creator's lab key store instead of being
// paired in through the S29 pairing API, and (S29c-B2) each device is certified by the vault's
// recovery identity from that store so the lab gates verify its signed frames; the inbound edits are catalog events validated with `parseEvent`, because the store has
// no commands for most of them yet (S22d / S43) and no command -> engine writer exists.
import { join } from "node:path";
import { NodeFolderFs, openNodeSqlite } from "@cashu/node-host";
import { builtinModules, metaClockStore, Store, v1, vaultSalt } from "@cashu/store";
import {
  createOwnLogCarrier,
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  FolderTransport,
  MemoryTransport,
  type SyncEngine,
  type UnstampedEvent,
} from "@cashu/sync";
import { labGate } from "../keys/labGate.js";
import { certifyLabDevice } from "../keys/vaultKeys.js";

export interface HarnessDevice {
  readonly device: string;
  readonly store: Store;
  readonly engine: SyncEngine;
  /** Sets the device's physical clock (ms). */
  setClock(ms: number): void;
  /** Writes validated catalog events (unstamped wire form) through the engine. */
  write(events: readonly UnstampedEvent[]): Promise<void>;
  close(): Promise<void>;
}

/** A device of `vaultId` on the shared remote folder, its view in `dbPath` (":memory:" allowed). */
export async function openDevice(o: {
  readonly sodium: crypto.Sodium;
  readonly ring: crypto.Keyring;
  /** The lab key store holding the vault's recovery words and device certificates. */
  readonly keyStore: crypto.KeyStore;
  readonly remote: string;
  readonly dbPath: string;
  readonly clockMs: number;
}): Promise<HarnessDevice> {
  const identity = crypto.createDeviceIdentity(o.sodium);
  const device = identity.deviceId;
  await certifyLabDevice(o.keyStore, o.sodium, o.ring.vaultId, identity);
  const gate = await labGate(o.keyStore, o.sodium, o.ring);
  const secret = o.ring.gidSalt();
  const salt = vaultSalt(secret.expose().slice());
  secret.wipe();
  const store = Store.open({
    driver: openNodeSqlite(o.dbPath),
    vault: o.ring.vaultId,
    salt,
    modules: builtinModules(),
  });
  const codec = createOwnLogCodec({ sodium: o.sodium, ring: o.ring, signer: identity });
  let now = o.clockMs;
  const engine = await createSyncEngine({
    vault: o.ring.vaultId,
    device,
    local: new MemoryTransport(),
    remotes: [
      createOwnLogCarrier({
        transport: new FolderTransport({ fs: new NodeFolderFs(o.remote), owner: device }),
        codec,
        gate,
        device,
      }),
    ],
    codec,
    gate,
    sink: store.sink(),
    clockStore: metaClockStore(store.driver, device),
    physicalClock: { now: () => now },
  });
  return {
    device,
    store,
    engine,
    setClock(ms) {
      now = ms;
    },
    async write(events) {
      for (const e of events) {
        const parsed = v1.parseEvent({
          eid: e.i,
          vault: o.ring.vaultId,
          device,
          hlc: `000000000-0000-${device}`,
          at: e.a,
          type: e.t,
          v: e.v,
          gid: e.g,
          data: e.d,
        });
        if (parsed.status !== "known")
          throw new Error(`an inbound event of ${e.t} does not validate`);
      }
      await engine.write(events);
    },
    async close() {
      await engine.close();
      store.close();
    },
  };
}

/** The verifier's view database name of a vault ordinal (inside `<run>/verifier`). */
export const verifierDb = (ordinal: number) => `v${ordinal}.db`;

/** Opens the verifier of one vault: a fresh device whose store lives in `<run>/verifier`. */
export function openVerifier(o: {
  readonly sodium: crypto.Sodium;
  readonly ring: crypto.Keyring;
  readonly keyStore: crypto.KeyStore;
  readonly remote: string;
  readonly run: string;
  readonly ordinal: number;
  readonly clockMs: number;
}): Promise<HarnessDevice> {
  return openDevice({ ...o, dbPath: join(o.run, "verifier", verifierDb(o.ordinal)) });
}
