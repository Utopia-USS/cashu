// TRANSITIONAL(S49): a synthetic lab for the sync service tests: a synthetic Python data dir with
// linked vaults (lab key store under a fake home's `cashu-lab`), the bridge configuration, and a fake
// `cashu` CLI run as a real child (fakeCashu.ts). Synthetic data only.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crypto } from "@cashu/sync";
import { tempDir } from "../../testing/harness.js";
import { BRIDGE_CONFIG_FILE } from "../config.js";
import { labFileKeyStore } from "../keys/labFile.js";
import { createVault } from "../keys/vaultKeys.js";
import { SyntheticPython } from "./python.js";

export const GID_A = "01JQ0000000000000000000001";
export const GID_B = "01JQ0000000000000000000002";

const sodium = await crypto.loadNodeSodium();
const RESOLVE_TS = fileURLToPath(
  new URL("../../../../../tools/node-ts/resolveTs.ts", import.meta.url),
);
const FAKE_CASHU = fileURLToPath(new URL("./fakeCashu.ts", import.meta.url));

const pythons: SyntheticPython[] = [];

export interface Lab {
  /** The fake home (its `cashu-lab` holds the keys, the state root and the remote). */
  readonly home: string;
  /** The Python data dir = the host's data dir. */
  readonly py: SyntheticPython;
  readonly dir: string;
  readonly keys: string;
  readonly stateRoot: string;
  readonly remote: string;
}

/** A synthetic Python data dir with `profiles` linked vaults and the bridge configuration. */
export async function lab(profiles: number, over: Record<string, unknown> = {}): Promise<Lab> {
  const home = tempDir("cashu-bridge-home-");
  const dir = join(home, "cashu-lab", "run");
  mkdirSync(dir, { recursive: true });
  const py = new SyntheticPython();
  pythons.push(py);
  const keys = join(dir, "keys.json");
  for (let p = 1; p <= profiles; p++) {
    py.profile(p, `syn-${p}`);
    const k = await createVault(labFileKeyStore(keys), sodium);
    py.link(p, k.ring.vaultId);
  }
  const stateRoot = join(dir, "state");
  const remote = join(dir, "remote");
  const config = {
    format: 2,
    python: {
      argv: [
        process.execPath,
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "--import",
        RESOLVE_TS,
        FAKE_CASHU,
      ],
      env: { FAKE_CASHU_DB: join(py.dir, "cashu.db") },
    },
    stateRoot,
    remotes: [{ kind: "folder", root: remote }],
    keys: { kind: "lab-file", path: keys, pythonKeyring: join(dir, "keyring.json") },
    pollMs: 50,
    carrierMs: 60_000,
    ...over,
  };
  writeFileSync(join(py.dir, BRIDGE_CONFIG_FILE), JSON.stringify(config));
  return { home, py, dir: py.dir, keys, stateRoot, remote };
}

/** Closes and removes the synthetic Python data dirs (the homes go with `cleanup`). */
export function closeLabs(): void {
  for (const p of pythons.splice(0)) {
    p.close();
    rmSync(p.dir, { recursive: true, force: true });
  }
}
