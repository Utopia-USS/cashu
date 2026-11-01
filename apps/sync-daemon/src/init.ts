// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 8).
//
// First start: every profile of a quiescent Python data dir (no Python process writes during `init`)
// becomes a vault created by this device. Genesis reads the live database in one read transaction
// (the S48 runbook stops the app; the lab harness simply does not write), the genesis log is written
// as the vault's genesis pseudo-device stream by a second engine with the fixed physical clock W (the
// HLC send rule then gives exactly gid.md 7.1's sequence: every stamped HLC is checked against
// genesis's, `genesis-hlc-mismatch` otherwise), in one-frame chunks (spec 5.2), folded into the view
// through the same store sink, then Python's `sync_ids` is seeded (`cashu sync seed`, which links the
// vault and verifies the salt), and only then is the stream pushed to the remotes.
//
// Deviations (S31a checkpoint): genesis reads the live database in one read transaction instead of a
// copy (the precondition is quiescence either way); `init` runs over every profile at once and is not
// resumable mid-way (a failed init is discarded with its run: nothing left the machine before the
// push); the S29 registry's first device statement is out of phase 1 (TRANSITIONAL(S44)).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bridge, type genesis, vaultSalt } from "@cashu/store";
import type { crypto } from "@cashu/sync";
import type { DaemonConfig } from "./config.js";
import { writePythonGidSalt } from "./keys/labFile.js";
import { createVault } from "./keys/vaultKeys.js";
import type { PythonCli } from "./python/cli.js";
import type { PythonReader } from "./python/reader.js";
import { genesisEngine, openVault, type VaultKeys } from "./vault.js";

/** `,"h":` is already in a genesis wire event: the engine's frame split sees the same bytes. */
function frameChunks(events: readonly genesis.GenesisVault["events"][number][]) {
  const chunks: (typeof events)[number][][] = [];
  let current: (typeof events)[number][] = [];
  let bytes = 0;
  for (const e of events) {
    const n = JSON.stringify(e).length;
    if (
      current.length > 0 &&
      (current.length >= bridge.FRAME_EVENTS || bytes + n > bridge.FRAME_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(e);
    bytes += n;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export class InitRefusedError extends Error {
  readonly exitCode = 64;
  constructor(reason: string) {
    super(`init refused: ${reason}`);
    this.name = "InitRefusedError";
  }
}

export interface InitDeps {
  readonly config: DaemonConfig;
  readonly reader: PythonReader;
  readonly cli: PythonCli;
  readonly sodium: crypto.Sodium;
  readonly keyStore: crypto.KeyStore;
  /** The caller's clock: only genesis's clock-skew guard reads it. */
  readonly now: number;
  readonly out: (line: Readonly<Record<string, unknown>>) => void;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export async function initVaults(d: InitDeps): Promise<void> {
  if (d.reader.vaults().length > 0) throw new InitRefusedError("a profile is already linked");
  const profiles = d.reader.profiles();
  const created = new Map<string, VaultKeys>();
  const keys = new Map<string, genesis.VaultKeys>();
  for (const p of profiles) {
    const k = await createVault(d.keyStore, d.sodium);
    const secret = k.ring.gidSalt();
    const saltBytes = secret.expose().slice();
    secret.wipe();
    writePythonGidSalt(d.config.keys.pythonKeyring, k.ring.vaultId, hex(saltBytes));
    created.set(p.slug, k);
    keys.set(p.slug, { vault: k.ring.vaultId, salt: vaultSalt(saltBytes) });
  }
  const result = d.reader.genesis(keys, d.now);
  const remotes = d.config.remotes.map((r) => r.root);
  for (const v of result.vaults) {
    const k = created.get(v.slug);
    if (k === undefined) throw new Error("genesis returned a vault init did not create");
    const vault = await openVault({
      ordinal: v.ordinal,
      profileId: v.profileId,
      stateRoot: d.config.stateRoot,
      remotes: [],
      keys: k,
      sodium: d.sodium,
    });
    try {
      const writer = await genesisEngine(vault, v.wall, []);
      const chunks = frameChunks(v.events);
      for (const [i, chunk] of chunks.entries()) {
        const unstamped = chunk.map(({ h: _h, ...rest }) => rest);
        const r = await writer.write(unstamped);
        if (r.first !== chunk[0]?.h || r.last !== chunk.at(-1)?.h || r.frames !== 1) {
          throw new InitRefusedError("genesis-hlc-mismatch");
        }
        vault.state.setGenesis({ status: "writing", chunksWritten: i + 1, wall: v.wall });
      }
      await writer.close();
      const tmp = join(vault.dir, "tmp");
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const seeded = d.cli.seed(v.slug, v.ids, tmp);
      const pusher = await genesisEngine(vault, v.wall, remotes);
      await pusher.sync();
      await pusher.close();
      vault.state.setGenesis({ status: "done", chunksWritten: chunks.length, wall: v.wall });
      d.out({
        step: "init",
        vault: v.ordinal,
        events: v.events.length,
        chunks: chunks.length,
        ids: v.ids.length,
        seeded,
        log: v.logSha256.slice(0, 12),
      });
    } finally {
      await vault.close();
    }
  }
}
