// The out dir of `cashu-next genesis` (S26 spec 9.4, D-G11 lab layout). Plaintext vault logs: the
// folders are 0700 and the files 0600, and the dir is never inside the data dir or a git work tree
// (`refusePaths` of @cashu/node-host). Vault folders are named by ordinal (profiles ordered by id),
// never by slug.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@cashu/store";
import type * as genesis from "@cashu/store/genesis";
import type { SourceManifest } from "./copy.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** What the manifest and stdout carry of one vault: counts, hashes and the genesis device id. */
export interface VaultSummary {
  readonly ordinal: number;
  readonly events: number;
  readonly ids: number;
  readonly logSha256: string;
  /** The base wall W of the log (ISO 8601 UTC). */
  readonly wall: string;
  readonly device: string;
  /** The folded view's hash (`--fold` only). */
  readonly view?: string;
}

const writePrivate = (path: string, text: string) =>
  writeFileSync(path, text, { mode: FILE_MODE, flag: "wx" });

/** The folder of one vault inside `out`. */
export const vaultDir = (out: string, ordinal: number) => join(out, `vault-${ordinal}`);

/**
 * Writes `events.jsonl` (the genesis log), `ids.jsonl` (one `{"table","localId","gid"}` line per
 * exported row, the input of `cashu sync seed --ids`) and `device-local.json` (the D-G10 sidecar).
 */
export function writeVault(out: string, vault: genesis.GenesisVault): VaultSummary {
  const dir = vaultDir(out, vault.ordinal);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  writePrivate(join(dir, "events.jsonl"), vault.lines.join(""));
  writePrivate(
    join(dir, "ids.jsonl"),
    vault.ids
      .map((e) => `${JSON.stringify({ table: e.table, localId: e.localId, gid: e.gid })}\n`)
      .join(""),
  );
  writePrivate(join(dir, "device-local.json"), `${canonicalJson(vault.deviceLocal)}\n`);
  return {
    ordinal: vault.ordinal,
    events: vault.events.length,
    ids: vault.ids.length,
    logSha256: vault.logSha256,
    wall: new Date(vault.wall).toISOString(),
    device: vault.device,
  };
}

export interface RunManifest {
  readonly source: SourceManifest;
  readonly schema: string;
  readonly vaults: readonly VaultSummary[];
  readonly report: genesis.GenesisReport;
}

/** `<out>/manifest.json`: `{format: 1, source, schema, vaults, report}` (counts and hashes only). */
export function writeManifest(out: string, run: RunManifest): void {
  const manifest = {
    format: 1,
    source: { files: run.source.files, sha256: run.source.sha256 },
    schema: run.schema,
    vaults: run.vaults.map((v) => ({
      ordinal: v.ordinal,
      events: v.events,
      ids: v.ids,
      log_sha256: v.logSha256,
      W: v.wall,
      device: v.device,
      ...(v.view === undefined ? {} : { view_hash: v.view }),
    })),
    report: run.report,
  };
  writePrivate(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Creates the out dir (it does not exist or is empty: guard.ts / command.ts checked). */
export function createOut(out: string): void {
  mkdirSync(out, { recursive: true, mode: DIR_MODE });
}
