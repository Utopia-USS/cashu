/// <reference types="node" />
/**
 * Dataset reads execute native handlers on the genesis-folded vault. Python trees supply only
 * the comparison oracle; native module and error results are computed independently.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  decodeEntityRef,
  type InvestmentWriteServices,
  loadAccountLabels,
  loadGuard,
  mcpToolMetadata,
  type NativeToolStore,
  type ResearchServices,
  scrubText,
  toolContext,
} from "@cashu/mcp";
import { mcpProfile } from "@cashu/store/core";
import { type CanonObject, type CanonValue, parseCanonical } from "../../json.ts";
import { DATASET_CLOCKS, type Dataset, goldenRoot, type PythonDb } from "../../sources/index.ts";
import type { ProfileRow } from "../../sources/pythonDb.ts";
import { copiedOverviewPrices } from "../core/overviewMarket.ts";
import { nativeViewSources } from "../investments/viewSource.ts";
import type { OutValue } from "../output.ts";
import { genesisRun } from "../store/genesisRun.ts";
import { GidKeys } from "../store/gidKeys.ts";
import { bindConnectorReads } from "./connectorSource.ts";
import { bindInvestmentHistory } from "./historySource.ts";
import { bindInvestmentReads } from "./investmentSource.ts";
import { bindInvestmentWriteReads } from "./investmentWriteSource.ts";
import { mergeMcpReads, nativeMcpReads } from "./nativeReads.ts";
import { bindResearchReads } from "./researchSource.ts";

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

/** Independent native outputs for one profile; no oracle tree or expected result is read. */
export async function nativeProfileMcpReads(db: PythonDb, mode: PrivacyMode, profile: ProfileRow) {
  const vaults = genesisRun(db).vaults;
  const vault = vaults.get(profile.id);
  if (vault === undefined) throw new Error("MCP provider parity: missing genesis vault");
  // Match the Python oracle's caller identity only here. The host uses the stable vault id,
  // since two native vaults may each have the same local profile row id.
  const read = vault.store.read.bind(vault.store);
  const guard = loadGuard(read, profile.id, PARITY_PAYEE_KEY);
  const nativeProfile = mcpProfile(read);
  if (nativeProfile === undefined) throw new Error("MCP parity: missing native profile");
  const keys = new GidKeys(vault, db.keys);
  const marketData = nativeViewSources(db).find((source) => source.profile.id === profile.id)
    ?.marketData.data;
  let research: ResearchServices | undefined;
  let investmentWrites: InvestmentWriteServices | undefined;
  const store: NativeToolStore = {
    get investmentWrites() {
      return investmentWrites;
    },
    get research() {
      return research;
    },
    read,
    profile: nativeProfile,
    today: db.asOf,
    now: () => Date.parse(`${DATASET_CLOCKS[db.dataset]}Z`),
    prices: copiedOverviewPrices(db),
    ...(marketData === undefined ? {} : { marketData }),
    fxNewest: db.investments
      .fxRates()
      .reduce<string | null>(
        (newest, row) => (newest === null || row.date > newest ? row.date : newest),
        null,
      ),
    toolInventory: mcpToolMetadata(),
    connectors: bindConnectorReads(db, profile.id),
    ...(nativeProfile.modules.includes("investments")
      ? {
          investments: bindInvestmentReads(db, profile.id),
          investmentHistory: bindInvestmentHistory(db, profile.id),
        }
      : {}),
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
  if (nativeProfile.modules.includes("investments")) {
    research = bindResearchReads(db, profile.id, context);
    investmentWrites = bindInvestmentWriteReads(db, profile.id, context);
  }
  const native = await nativeMcpReads(
    context,
    new Set(nativeProfile.modules),
    (gid) => {
      const key = keys.ref("loans", gid);
      if (key === null) throw new Error("MCP parity: missing native loan identity");
      return key;
    },
    {
      ref(kind, gid) {
        const tables: Readonly<Record<string, string>> = {
          instrument: "inv_instruments",
          signal: "inv_signals",
          thesis: "inv_theses",
          alert: "alerts",
          run: "research_runs",
          note: "research_notes",
          watchlist: "watchlist_items",
        };
        const table = tables[kind];
        if (table === undefined) throw new Error("unsupported native reference kind");
        const key = keys.ref(table, gid);
        if (key === null) throw new Error("missing native investment identity");
        return key;
      },
      searchKey(value) {
        if (!value.startsWith("i:")) return value;
        const gid = decodeEntityRef("instrument", value.slice(2));
        keys.ref("inv_instruments", gid);
        const source = keys.source(gid);
        if (source?.table !== "inv_instruments") throw new Error("missing native search identity");
        return scrubText(`i:${source.localId}`, {
          strict: context.strict,
          guard: context.guard,
        });
      },
      rule(value) {
        if (!/^alert:(?:u[a-p]{52}|v[a-p]{32})$/u.test(value)) return value;
        const gid = decodeEntityRef("alert", value);
        keys.ref("alerts", gid);
        const source = keys.source(gid);
        if (source === undefined || source.table !== "alerts")
          throw new Error("missing native alert rule identity");
        // Python labels this literal counter as text. Match its legacy masking only after the
        // production opaque reference passed redaction/leak checking and source-table validation.
        return scrubText(`alert:${source.localId}`, {
          strict: context.strict,
          guard: context.guard,
        });
      },
    },
  );
  return { native, guard };
}

export async function produceMcpRead(
  db: PythonDb,
  mode: PrivacyMode,
  rawRoot: string = goldenRoot(),
): Promise<OutValue> {
  const raw = asObject(
    parseCanonical(readFileSync(rawGoldenPath(db.dataset, rawRoot), "utf8")),
    "mcp.read_raw",
  );
  const perProfile = asObject(raw.get(mode), mode),
    out: Record<string, OutValue> = {};
  for (const profile of db.profiles()) {
    const pkey = db.keys.key("profiles", profile.id),
      calls = asObject(perProfile.get(pkey), "a profile of mcp.read_raw");
    const { native } = await nativeProfileMcpReads(db, mode, profile);
    out[pkey] = mergeMcpReads(calls, native);
  }
  if (Object.keys(out).length !== perProfile.size)
    throw new Error("mcp.read_raw has profiles the dataset lacks");
  return out;
}
