import { toCurrency } from "@cashu/domain/investments";
import { expect, it } from "vitest";
import type { Store } from "../../materialize.js";
import { viewHash } from "../../snapshot.js";
import { openTestStore } from "../../testing/store.js";
import type { StrategyFilesPort } from "../services/strategy.js";
import { loadStrategy } from "../services/strategy.js";
import { household } from "../testing/household.js";
import { projectStoredStrategyStatus } from "./strategyStatus.js";

/** Load the files, then project the stored status (what an explicit read does). */
async function readStrategyStatus(
  store: Store,
  request: {
    readonly files: StrategyFilesPort;
    readonly paths: { readonly yaml: string; readonly md: string };
    readonly profileBase: ReturnType<typeof toCurrency>;
    readonly lang: "pl" | "en";
  },
) {
  const state = await loadStrategy(store, request.files);
  const [yamlExists, mdExists] = await Promise.all([
    request.files.exists("strategy.yaml"),
    request.files.exists("strategy.md"),
  ]);
  return projectStoredStrategyStatus(store.read.bind(store), {
    state,
    profileBase: request.profileBase,
    lang: request.lang,
    files: { ...request.paths, yamlExists, mdExists },
  });
}

it("shows file-only strategy edits and read failures with no implicit version or file writes", async () => {
  const h = household();
  const store = openTestStore();
  store.applyEnvelopes(h.events);
  let yaml: string | null = null;
  let failed = false;
  const files: StrategyFilesPort = {
    read: async (name) =>
      failed ? { error: "Synthetic read failure" } : name === "strategy.yaml" ? yaml : null,
    exists: async (name) => name === "strategy.yaml" && yaml !== null,
    write: async () => {
      throw new Error("view attempted a file write");
    },
  };
  const request = {
    files,
    paths: { yaml: "strategy.yaml", md: "strategy.md" },
    profileBase: toCurrency("PLN"),
    lang: "pl" as const,
  };
  const before = viewHash(store);
  expect((await readStrategyStatus(store, request)).state).toBe("missing");
  yaml = "version: 1\nbase_currency: EUR\nrules: []\n";
  const changed = await readStrategyStatus(store, request);
  expect(changed.state).toBe("valid");
  expect(changed.version).toBeNull();
  expect(changed.changed).toBe(true);
  expect(changed.base_currency_note).toContain("Waluta bazowa strategii");
  failed = true;
  expect((await readStrategyStatus(store, request)).read_error).toContain("Synthetic read failure");
  expect(viewHash(store)).toEqual(before);
  store.close();
});
