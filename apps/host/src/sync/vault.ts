// TRANSITIONAL(S49): the host's outbox bridge (S31a spec 5.1).
//
// One vault on this device: the view store (`view.db`), the local own-log copy (`log/`, a folder
// transport over the durable Node `FolderFs`), the configured remote folders behind the manifest-gated
// own-log carrier, the frame codec over the vault ring, and the sync engine. The one factory of the
// engine. S29c-B2: the codec signs as this device (the genesis engine as the genesis device), and
// every frame's signed head is checked by the vault's frame gate (keys/labGate.ts in the lab). The
// databases open through `openDb`: in the host an exclusive open under the writer lease (service.ts),
// so a second process (or a second host on another data dir naming the same state root) cannot open
// the vault and fork this device's stream.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { NodeFolderFs } from "@cashu/node-host";
import {
  builtinModules,
  metaClockStore,
  metaGateStateStore,
  mintUlid,
  type SqlDriver,
  Store,
  type VaultSalt,
  vaultSalt,
} from "@cashu/store";
import * as genesis from "@cashu/store/genesis";
import {
  createOwnLogCarrier,
  createOwnLogCodec,
  createSyncEngine,
  type crypto,
  FolderTransport,
  type FrameCodec,
  type FrameGate,
  type PhysicalClock,
  type SyncEngine,
  type Transport,
} from "@cashu/sync";
import { VaultState } from "./state.js";

export interface VaultKeys {
  readonly ring: crypto.Keyring;
  readonly identity: crypto.DeviceIdentity;
}

export interface OpenVault {
  readonly ordinal: number;
  readonly profileId: number;
  readonly vaultId: string;
  readonly device: string;
  /** The vault's genesis pseudo-device (its events came from this Python too). */
  readonly genesisDevice: string;
  readonly salt: VaultSalt;
  readonly dir: string;
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly state: VaultState;
  /** The local own-log copy, the gate and the ring (the genesis engine of `init` uses them). */
  readonly local: Transport;
  readonly gate: FrameGate;
  readonly ring: crypto.Keyring;
  close(): Promise<void>;
}

export interface VaultOptions {
  readonly ordinal: number;
  readonly profileId: number;
  readonly stateRoot: string;
  readonly remotes: readonly string[];
  readonly keys: VaultKeys;
  readonly sodium: crypto.Sodium;
  /** Verifies every frame's signed head (keys/labGate.ts). */
  readonly gate: FrameGate;
  /** Opens (or creates) one of the vault's databases: `view.db`, `bridge.db`. */
  readonly openDb: (path: string) => SqlDriver;
}

/** `<stateRoot>/v<ordinal>` (private): named by the ordinal, never the slug or the vault id. */
function vaultDir(stateRoot: string, ordinal: number): string {
  const dir = join(stateRoot, `v${ordinal}`);
  mkdirSync(join(dir, "log"), { recursive: true, mode: 0o700 });
  return dir;
}

/** Remote folder transports for `device`, each behind the manifest-gated own-log carrier. */
function remoteTransports(
  roots: readonly string[],
  codec: FrameCodec,
  gate: FrameGate,
  device: string,
): Transport[] {
  return roots.map((root) =>
    createOwnLogCarrier({
      transport: new FolderTransport({ fs: new NodeFolderFs(root), owner: device }),
      codec,
      gate,
      device,
    }),
  );
}

export async function openVault(o: VaultOptions): Promise<OpenVault> {
  const { ring, identity } = o.keys;
  const dir = vaultDir(o.stateRoot, o.ordinal);
  const secret = ring.gidSalt();
  const salt = vaultSalt(secret.expose().slice());
  secret.wipe();
  // bridge.db first: an exclusive open that fails (another holder) fails before anything else opens.
  const state = new VaultState(o.openDb(join(dir, "bridge.db")));
  const local = new FolderTransport({ fs: new NodeFolderFs(join(dir, "log")) });
  let store: Store;
  try {
    store = Store.open({
      driver: o.openDb(join(dir, "view.db")),
      vault: ring.vaultId,
      salt,
      modules: builtinModules(),
    });
  } catch (error) {
    state.close();
    throw error;
  }
  const codec = createOwnLogCodec({ sodium: o.sodium, ring, signer: identity });
  let engine: SyncEngine;
  try {
    engine = await createSyncEngine({
      vault: ring.vaultId,
      device: identity.deviceId,
      local,
      remotes: remoteTransports(o.remotes, codec, o.gate, identity.deviceId),
      codec,
      gate: o.gate,
      sink: store.sink(),
      clockStore: metaClockStore(store.driver, identity.deviceId),
      // S29c-B3: the gate's snapshot, so a restart replays only the log's new tail.
      gateState: metaGateStateStore(store.driver, identity.deviceId),
      gossipEid: () => mintUlid(Date.now(), (n) => o.sodium.randomBytes(n)),
    });
  } catch (error) {
    store.close();
    state.close();
    throw error;
  }
  const device = identity.deviceId;
  return {
    ordinal: o.ordinal,
    profileId: o.profileId,
    vaultId: ring.vaultId,
    device,
    genesisDevice: genesis.genesisDevice(salt),
    salt,
    dir,
    store,
    engine,
    state,
    local,
    gate: o.gate,
    ring,
    async close() {
      await engine.close();
      store.close();
      state.close();
    },
  };
}

/**
 * The genesis device's engine of a vault (spec 8.4): a fixed physical clock W; `signer` is the
 * genesis identity while it writes (absent: a read-only codec, enough to push).
 */
export function genesisEngine(
  v: OpenVault,
  sodium: crypto.Sodium,
  wall: number,
  remotes: readonly string[],
  signer?: crypto.DeviceIdentity,
): Promise<SyncEngine> {
  const clock: PhysicalClock = { now: () => wall };
  const codec = createOwnLogCodec({ sodium, ring: v.ring, ...(signer ? { signer } : {}) });
  return createSyncEngine({
    vault: v.vaultId,
    device: v.genesisDevice,
    local: v.local,
    remotes: remoteTransports(remotes, codec, v.gate, v.genesisDevice),
    codec,
    gate: v.gate,
    sink: v.store.sink(),
    clockStore: metaClockStore(v.store.driver, v.genesisDevice),
    physicalClock: clock,
  });
}
