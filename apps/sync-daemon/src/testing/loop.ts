// Real loop fixtures shared by the fast recovery cases and exhaustive bulk import.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintUlid } from "@cashu/store";
import { crypto } from "@cashu/sync";

import { labFileKeyStore } from "../keys/labFile.js";
import { labGate } from "../keys/labGate.js";
import { createVault, loadVaultKeys } from "../keys/vaultKeys.js";
import { type CrashPoint, Loop } from "../loop.js";
import { PythonReader } from "../python/reader.js";
import { SyntheticPython } from "../testing/python.js";
import { type OpenVault, openVault } from "../vault.js";

const sodium = await crypto.loadNodeSodium();

class Crash extends Error {}

interface World {
  readonly py: SyntheticPython;
  readonly root: string;
  readonly vaultIds: readonly string[];
  readonly keysPath: string;
}

const cleanup: (() => void)[] = [];
export function cleanupLoop(): void {
  for (const f of cleanup.splice(0)) f();
}

export async function world(profiles: number): Promise<World> {
  const py = new SyntheticPython();
  const root = mkdtempSync(join(tmpdir(), "cashu-daemon-state-"));
  const keysPath = join(root, "keys.json");
  const store = labFileKeyStore(keysPath);
  const vaultIds: string[] = [];
  for (let p = 1; p <= profiles; p++) {
    py.profile(p, `syn-${p}`);
    const keys = await createVault(store, sodium);
    py.link(p, keys.ring.vaultId);
    vaultIds.push(keys.ring.vaultId);
  }
  cleanup.push(() => {
    py.close();
    rmSync(py.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { py, root, vaultIds, keysPath };
}

export async function openAll(w: World): Promise<OpenVault[]> {
  const store = labFileKeyStore(w.keysPath);
  const out: OpenVault[] = [];
  for (const [i, id] of w.vaultIds.entries()) {
    const keys = await loadVaultKeys(store, sodium, id);
    if (keys === undefined) throw new Error("keys");
    out.push(
      await openVault({
        ordinal: i,
        profileId: i + 1,
        stateRoot: join(w.root, "state"),
        remotes: [join(w.root, "remote")],
        keys,
        sodium,
        gate: await labGate(store, sodium, keys.ring, keys.identity),
      }),
    );
  }
  return out;
}

let tick = 0;
export const ports = {
  ulid: () => {
    tick += 1;
    return mintUlid(Date.UTC(2026, 2, 1) + tick, (n) => sodium.randomBytes(n));
  },
  isLeader: () => true,
};

export async function runLoop(w: World, crashAt?: CrashPoint) {
  const vaults = await openAll(w);
  const reader = new PythonReader(w.py.dir);
  const cli = w.py.cli();
  const lines: Record<string, unknown>[] = [];
  const loop = new Loop({
    reader,
    cli,
    vaults,
    slugs: new Map(vaults.map((v) => [v.profileId, `syn-${v.profileId}`])),
    ports,
    now: () => Date.UTC(2026, 2, 2),
    out: (l) => lines.push({ ...l }),
    at: (p) => {
      if (p === crashAt) throw new Crash(p);
    },
  });
  let crashed = false;
  try {
    for (;;) {
      const r = await loop.iteration();
      if (r.idle) break;
    }
  } catch (e) {
    if (!(e instanceof Crash)) throw e;
    crashed = true;
  }
  return {
    vaults,
    cli,
    lines,
    crashed,
    async close() {
      for (const v of vaults) await v.close();
      reader.close();
    },
  };
}

/** Bridge events held per vault, and whether any eid repeats. */
export function logOf(v: OpenVault) {
  const rows = v.store.read<{ eid: string; type: string }>(
    "SELECT eid, type FROM event_log ORDER BY seq",
  );
  return {
    count: rows.length,
    distinct: new Set(rows.map((r) => r.eid)).size,
    types: rows.map((r) => r.type),
  };
}
