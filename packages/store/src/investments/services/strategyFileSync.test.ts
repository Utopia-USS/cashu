// One device's strategy files following the recorded versions (strategyFileSync.ts): the first run
// without a journal, report-only callers, and a pass interrupted after its conflict proposal.
// Two devices with real sync engines: apps/host/src/proposals/strategyFollow.integration.test.ts.
import { strategyDigest } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { createProposal } from "../../core/proposal-commands.js";
import { saveStrategyVersion } from "../commands/strategy.js";
import { type Vault, vault } from "../commands/testing/fixtures.js";
import { strategyVersions } from "../queries/strategy.js";
import { MemoryStrategyDir } from "../testing/strategyFiles.js";
import { type StrategyFileSyncDeps, syncStrategyFiles } from "./strategyFileSync.js";

const V1 = "version: 1\nbase_currency: PLN\n";
const V2 = "version: 1\nbase_currency: EUR\n";
const EDIT = "version: 1\nbase_currency: CHF\n";

function deps(v: Vault, dir: MemoryStrategyDir, write = true): StrategyFileSyncDeps {
  return {
    store: v.store,
    files: dir.sync.files,
    journal: dir.sync.journal,
    isVaultCurrent: () => true,
    ...(write
      ? {
          record: async (input) => v.value(saveStrategyVersion, input),
          propose: async (input) => {
            v.value(createProposal, input);
          },
        }
      : {}),
  };
}
const pending = (v: Vault) =>
  v.store.read<{ payload: string }>("SELECT payload FROM proposals WHERE status = 'pending'");

describe("strategy file sync on one device", () => {
  it("a new device's empty directory receives the current version", async () => {
    const v = vault();
    v.value(saveStrategyVersion, { yamlText: V1, base: null });
    const dir = new MemoryStrategyDir(v.store.vault);
    expect(await syncStrategyFiles(deps(v, dir))).toMatchObject({ status: "followed" });
    expect(dir.texts.get("strategy.yaml")).toBe(V1);
    expect(await syncStrategyFiles(deps(v, dir))).toMatchObject({ status: "in_sync" });
  });

  it("without a journal, files equal to an older version follow instead of being recorded", async () => {
    const v = vault();
    v.value(saveStrategyVersion, { yamlText: V1, base: null });
    const first = strategyVersions(v.store.read.bind(v.store))[0]?.gid ?? null;
    v.value(saveStrategyVersion, { yamlText: V2, base: first });
    const dir = new MemoryStrategyDir(v.store.vault);
    dir.texts.set("strategy.yaml", V1);
    expect(await syncStrategyFiles(deps(v, dir))).toMatchObject({ status: "followed" });
    expect(dir.texts.get("strategy.yaml")).toBe(V2);
    expect(strategyVersions(v.store.read.bind(v.store))).toHaveLength(2);
  });

  it("a caller without write capability only reports the local edit or the conflict", async () => {
    const v = vault();
    const dir = new MemoryStrategyDir(v.store.vault);
    dir.texts.set("strategy.yaml", V1);
    await syncStrategyFiles(deps(v, dir));
    dir.texts.set("strategy.yaml", EDIT);
    expect(await syncStrategyFiles(deps(v, dir, false))).toMatchObject({ status: "local_edit" });
    const first = strategyVersions(v.store.read.bind(v.store))[0]?.gid ?? null;
    v.value(saveStrategyVersion, { yamlText: V2, base: first });
    expect(await syncStrategyFiles(deps(v, dir, false))).toMatchObject({ status: "conflict" });
    expect(dir.texts.get("strategy.yaml")).toBe(EDIT);
    expect(pending(v)).toEqual([]);
  });

  it("a pass interrupted after its conflict proposal does not propose the edit twice", async () => {
    const v = vault();
    const dir = new MemoryStrategyDir(v.store.vault);
    dir.texts.set("strategy.yaml", V1);
    await syncStrategyFiles(deps(v, dir));
    const first = strategyVersions(v.store.read.bind(v.store))[0]?.gid ?? null;
    dir.texts.set("strategy.yaml", EDIT);
    v.value(saveStrategyVersion, { yamlText: V2, base: first });
    const install = dir.sync.files.install;
    let failures = 1;
    const flaky = {
      ...deps(v, dir),
      files: {
        ...dir.sync.files,
        install: async (...args: Parameters<typeof install>) => {
          if (failures-- > 0) throw new Error("synthetic interrupted write");
          return install(...args);
        },
      },
    };
    await expect(syncStrategyFiles(flaky)).rejects.toThrow("synthetic interrupted write");
    expect(pending(v)).toHaveLength(1);
    // The next pass finishes the journaled write: the files follow, the proposal stays single.
    expect(await syncStrategyFiles(deps(v, dir))).toMatchObject({ status: "in_sync" });
    expect(dir.texts.get("strategy.yaml")).toBe(V2);
    const proposals = pending(v).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ yaml: EDIT, base_sha256: strategyDigest(V2, null) });
  });
});
