/// <reference types="node" />
/**
 * S38b's five dataset reads execute actual native handlers on the genesis-folded vault. Remaining
 * reads replay S02 labelled Python trees through native providers and privacy. Only unported
 * calls may pass through an oracle error; native module/error results are computed independently.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as macro from "@cashu/domain/investments/macro";
import {
  LeakDetected,
  leakCheck,
  loadAccountLabels,
  loadGuard,
  mcpToolMetadata,
  type NameGuard,
  type NativeToolStore,
  Redactor,
  toolContext,
  UnlabelledValue,
} from "@cashu/mcp";
import { mcpProfile } from "@cashu/store/core";
import { type CanonObject, type CanonValue, parseCanonical } from "../../json.ts";
import { DATASET_CLOCKS, type Dataset, goldenRoot, type PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { genesisRun } from "../store/genesisRun.ts";
import { GidKeys } from "../store/gidKeys.ts";
import { mergeMcpReads, nativeMcpReads } from "./nativeReads.ts";
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
    const read = vault.store.read.bind(vault.store);
    const guard = loadGuard(read, profile.id, PARITY_PAYEE_KEY);
    const nativeProfile = mcpProfile(read);
    if (nativeProfile === undefined) throw new Error("MCP parity: missing native profile");
    const keys = new GidKeys(vault, db.keys);
    const store: NativeToolStore = {
      read,
      profile: nativeProfile,
      today: db.asOf,
      now: () => Date.parse(`${DATASET_CLOCKS[db.dataset]}Z`),
      prices: null,
      fxNewest: null,
      toolInventory: mcpToolMetadata(),
      run: () => {
        throw new Error("MCP read parity attempted a mutation");
      },
    };
    const context = toolContext({
      store,
      profileId: profile.id,
      privacy: mode,
      today: db.asOf,
      loadGuard: () => guard,
      loadAccountLabels: () => loadAccountLabels(read),
    });
    const native = nativeMcpReads(context, new Set(nativeProfile.modules), (gid) => {
      const key = keys.ref("loans", gid);
      if (key === null) throw new Error("MCP parity: missing native loan identity");
      return key;
    });
    out[pkey] = mergeMcpReads(calls, native, (entry) =>
      entry instanceof Map && isPassThrough(entry)
        ? canonToOut(entry)
        : redactEntry(entry, mode, guard, summaryOk),
    );
  }
  if (Object.keys(out).length !== perProfile.size)
    throw new Error("mcp.read_raw has profiles the dataset lacks");
  return out;
}
