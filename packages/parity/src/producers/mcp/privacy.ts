/// <reference types="node" />
/**
 * `mcp.read_strict` / `mcp.read_amounts`: the S02 raw labelled trees (`mcp.read_raw`, captured before
 * redaction from every read tool of the Python MCP server) run through the TS privacy layer: the
 * profile's guard (`collectGuard` over the profile name, the account names from `PythonDb` and the
 * providers' outputs from the guard bridge), `Redactor.apply`, the "a tool returns an object" rule and
 * `leakCheck`, exactly as `checks/mcp.py` replays `CashuMcp._call`. Entries the raw golden holds no
 * tree for (a disabled module, a tool error, an unlabelled value) pass through unchanged.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { macro } from "@cashu/domain/investments";
import {
  collectGuard,
  LeakDetected,
  leakCheck,
  type NameGuard,
  Redactor,
  UnlabelledValue,
} from "@cashu/mcp";
import { type CanonObject, type CanonValue, parseCanonical } from "../../json.ts";
import { type Dataset, labRoot, type PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { type GuardBridge, readGuardBridge } from "./guardBridge.ts";
import { canonToOut, SyntheticIds, toCanonical, toLabelledTree } from "./rawTrees.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..");

/** The fixed payee key of the parity run copies (`golden.py` `PARITY_PAYEE_KEY`). */
const PARITY_PAYEE_KEY: Uint8Array = new Uint8Array(
  createHash("sha256").update("cashu-parity-payee-key-v1").digest(),
);

export type PrivacyMode = "strict" | "amounts";

function rawGoldenPath(dataset: Dataset, root: string = labRoot()): string {
  return dataset === "demo"
    ? join(REPO_ROOT, "parity", "golden-demo", "mcp.read_raw.json")
    : join(root, "parity", "out", "lab", "mcp.read_raw.json");
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
    leakCheck(data, { strict: redactor.strict, isins: redactor.isins });
  } catch (e) {
    if (e instanceof LeakDetected) return { error_kind: "privacy_check" };
    throw e;
  }
  return toCanonical(data, ids);
}

export function produceMcpRead(
  db: PythonDb,
  mode: PrivacyMode,
  bridge: GuardBridge = readGuardBridge(db.dataset),
): OutValue {
  debugDataset = db.dataset;
  const raw = asObject(
    parseCanonical(readFileSync(rawGoldenPath(db.dataset), "utf8")),
    "mcp.read_raw",
  );
  const perProfile = asObject(raw.get(mode), mode);
  const summaryOk = macro.summaryOk;
  const out: Record<string, OutValue> = {};
  for (const profile of db.profiles()) {
    const pkey = db.keys.key("profiles", profile.id);
    const calls = asObject(perProfile.get(pkey), "a profile of mcp.read_raw");
    const guard = collectGuard({
      profileId: profile.id,
      profileName: profile.name,
      accountNames: db.accounts(profile.id, { includeRemoved: true }).map((a) => a.name),
      providers: bridge.providers(pkey),
      secret: PARITY_PAYEE_KEY,
    });
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
