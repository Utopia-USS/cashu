// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 5.1).
//
// One vault on this device: the view store (`view.db`), the local own-log copy (`log/`, a folder
// transport over the durable Node `FolderFs`), the configured remote folders behind the manifest-gated
// own-log carrier, the frame codec over the vault ring, and the sync engine. The one factory of the
// engine: S29c-B2 (signed heads) adds the device signer here and nowhere else (spec 15.2).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { NodeFolderFs, openNodeSqlite } from "@cashu/node-host";
import {
  builtinModules,
  genesis,
  metaClockStore,
  Store,
  type VaultSalt,
  vaultSalt,
} from "@cashu/store";
import {
  createOwnLogCarrier,
  createOwnLogCodec,
  createSyncEngine,
  type crypto,
  FolderTransport,
  type FrameCodec,
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
  /** The local own-log copy and the codec (the genesis engine of `init` writes through them). */
  readonly local: Transport;
  readonly codec: FrameCodec;
  close(): Promise<void>;
}

export interface VaultOptions {
  readonly ordinal: number;
  readonly profileId: number;
  readonly stateRoot: string;
  readonly remotes: readonly string[];
  readonly keys: VaultKeys;
  readonly sodium: crypto.Sodium;
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
  device: string,
): Transport[] {
  return roots.map((root) =>
    createOwnLogCarrier({
      transport: new FolderTransport({ fs: new NodeFolderFs(root), owner: device }),
      codec,
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
  const store = Store.open({
    driver: openNodeSqlite(join(dir, "view.db")),
    vault: ring.vaultId,
    salt,
    modules: builtinModules(),
  });
  const codec = createOwnLogCodec({ sodium: o.sodium, ring });
  const local = new FolderTransport({ fs: new NodeFolderFs(join(dir, "log")) });
  const device = identity.deviceId;
  const engine = await createSyncEngine({
    vault: ring.vaultId,
    device,
    local,
    remotes: remoteTransports(o.remotes, codec, device),
    codec,
    sink: store.sink(),
    clockStore: metaClockStore(store.driver, device),
  });
  const state = new VaultState(openNodeSqlite(join(dir, "bridge.db")));
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
    codec,
    async close() {
      await engine.close();
      store.close();
      state.close();
    },
  };
}

/** The genesis pseudo-device's engine of a vault (spec 8.4): a fixed physical clock W. */
export function genesisEngine(
  v: OpenVault,
  wall: number,
  remotes: readonly string[],
): Promise<SyncEngine> {
  const clock: PhysicalClock = { now: () => wall };
  return createSyncEngine({
    vault: v.vaultId,
    device: v.genesisDevice,
    local: v.local,
    remotes: remoteTransports(remotes, v.codec, v.genesisDevice),
    codec: v.codec,
    sink: v.store.sink(),
    clockStore: metaClockStore(v.store.driver, v.genesisDevice),
    physicalClock: clock,
  });
}
