/// <reference types="node" />
/**
 * `mcp.read_strict` / `mcp.read_amounts`: the S02 raw labelled trees (`mcp.read_raw`, captured before
 * redaction from every read tool of the Python MCP server) run through the TS privacy layer: the
 * profile's guard (real native providers over the dataset's genesis-folded vault), `Redactor.apply`,
 * the "a tool returns an object" rule and
 * `leakCheck`, exactly as `checks/mcp.py` replays `CashuMcp._call`. Entries the raw golden holds no
 * tree for (a disabled module, a tool error, an unlabelled value) pass through unchanged.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as macro from "@cashu/domain/investments/macro";
import {
  LeakDetected,
  leakCheck,
  loadGuard,
  type NameGuard,
  Redactor,
  UnlabelledValue,
} from "@cashu/mcp";
import { type CanonObject, type CanonValue, parseCanonical } from "../../json.ts";
import { type Dataset, goldenRoot, type PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { genesisRun } from "../store/genesisRun.ts";
import { canonToOut, SyntheticIds, toCanonical, toLabelledTree } from "./rawTrees.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..");

/** The fixed payee key of the parity run copies (`golden.py` `PARITY_PAYEE_KEY`). */
const PARITY_PAYEE_KEY: Uint8Array = new Uint8Array(
  createHash("sha256").update("cashu-parity-payee-key-v1").digest(),
);

export type PrivacyMode = "strict" | "amounts";

/** The raw golden the trees come from: the committed demo golden, or `<golden root>/lab` (`golden.py --out`). */
/** The golden dir the MCP producers read `mcp.read_raw.json` from (demo: the committed set). */
export function rawGoldenDir(dataset: Dataset, root: string = goldenRoot()): string {
  return dataset === "demo" ? join(REPO_ROOT, "parity", "golden-demo") : join(root, "lab");
}

function rawGoldenPath(dataset: Dataset, root: string): string {
  return join(rawGoldenDir(dataset, root), "mcp.read_raw.json");
}

function asObject(value: CanonValue | undefined, what: string): CanonObject {
  if (!(value instanceof Map)) throw new Error(`${what}: not an object`);
  return value;
}

/** A raw golden entry without a tree: `{error_kind[, error]}` with plain string values. */
function isPassThrough(entry: CanonObject): boolean {
  return (
    entry.has("error_kind") &&
    typeof entry.get("error_kind") === "string" &&
    [...entry.keys()].every((k) => k === "error_kind" || k === "error")
  );
}

let debugDataset: Dataset | null = null;

function redactEntry(
  raw: CanonValue,
  mode: PrivacyMode,
  guard: NameGuard,
  summaryOk: (t: string) => boolean,
): OutValue {
  const ids = new SyntheticIds();
  const tree = toLabelledTree(raw, ids);
  const redactor = new Redactor({ privacy: mode, guard, summaryOk });
  let data: ReturnType<Redactor["apply"]>;
  try {
    data = redactor.apply(tree);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new UnlabelledValue("a tool must return an object");
    }
  } catch (e) {
    if (e instanceof UnlabelledValue) {
      // the message names JSON paths only; still printed for the synthetic dataset only
      if (process.env.CASHU_PARITY_DEBUG && debugDataset === "demo") console.error(e.message);
      return { error_kind: "unlabelled" };
    }
    throw e;
  }
  try {
    leakCheck(data, {
      strict: redactor.strict,
      isins: redactor.isins,
      nonMoney: redactor.nonMoney,
    });
  } catch (e) {
    if (e instanceof LeakDetected) return { error_kind: "privacy_check" };
    throw e;
  }
  return toCanonical(data, ids);
}

export function produceMcpRead(
  db: PythonDb,
  mode: PrivacyMode,
  rawRoot: string = goldenRoot(),
): OutValue {
  debugDataset = db.dataset;
  const raw = asObject(
    parseCanonical(readFileSync(rawGoldenPath(db.dataset, rawRoot), "utf8")),
    "mcp.read_raw",
  );
  const perProfile = asObject(raw.get(mode), mode);
  const summaryOk = macro.summaryOk;
  const vaults = genesisRun(db).vaults;
  const out: Record<string, OutValue> = {};
  for (const profile of db.profiles()) {
    const pkey = db.keys.key("profiles", profile.id);
    const calls = asObject(perProfile.get(pkey), "a profile of mcp.read_raw");
    const vault = vaults.get(profile.id);
    if (vault === undefined) throw new Error("MCP provider parity: missing genesis vault");
    // Match the Python oracle's caller identity only here. The host uses the stable vault id,
    // since two native vaults may each have the same local profile row id.
    const guard = loadGuard(vault.store.read.bind(vault.store), profile.id, PARITY_PAYEE_KEY);
    const entries: Record<string, OutValue> = {};
    for (const [call, entry] of calls) {
      entries[call] =
        entry instanceof Map && isPassThrough(entry)
          ? canonToOut(entry)
          : redactEntry(entry, mode, guard, summaryOk);
    }
    out[pkey] = entries;
  }
  if (Object.keys(out).length !== perProfile.size)
    throw new Error("mcp.read_raw has profiles the dataset lacks");
  return out;
}
