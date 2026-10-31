/// <reference types="node" />
/**
 * TRANSITIONAL(S38): reader of the guard bridge (`guard_bridge.py`): per profile, the raw outputs of
 * the MCP name providers (budget `name_sources`, investments `strong_names` / `name_sources` /
 * `strict_aliases`) that `collectGuard` runs on, until those providers are ported (S38). Delete with
 * the bridge script.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NameSources } from "@cashu/mcp";
import { bridgeMcpRoot, type Dataset } from "../../sources/index.ts";

const BRIDGE_CHECK = "mcp.guard_sources";

interface BridgeProvider {
  readonly provider: string;
  readonly strong: readonly string[];
  readonly persons: readonly string[];
  readonly private: readonly string[];
  readonly aliases: readonly (readonly [string, string])[];
  /** Digit-only tickers of the profile's instruments (S37fix R5; absent in older bridge files). */
  readonly symbols?: readonly string[];
}

interface BridgeFile {
  readonly profiles: Readonly<Record<string, { readonly providers: readonly BridgeProvider[] }>>;
}

export interface GuardBridge {
  /** The name sources of a profile (by natural key), in provider order. */
  providers(profileKey: string): NameSources[];
}

/** `root` is the bridge root `guard_bridge.py --out` wrote (default: the shared `<lab>/parity/bridge-mcp`). */
export function readGuardBridge(dataset: Dataset, root: string = bridgeMcpRoot()): GuardBridge {
  const path = join(root, dataset, `${BRIDGE_CHECK}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `no guard bridge output for ${dataset} under ${root}: run .venv/bin/python packages/parity/src/producers/mcp/guard_bridge.py --dataset ${dataset} --out ${root}`,
    );
  }
  const file = JSON.parse(readFileSync(path, "utf8")) as BridgeFile;
  return {
    providers(profileKey) {
      const entry = file.profiles[profileKey];
      if (entry === undefined) throw new Error("a profile without guard sources in the bridge");
      return entry.providers.map((p) => ({
        strongNames: p.strong,
        persons: p.persons,
        privatePayees: p.private,
        strictAliases: p.aliases,
        knownSymbols: p.symbols ?? [],
      }));
    },
  };
}
