// Owner approval of agent strategy and custom-rule proposals on a native vault, through the same
// `core.desktopProposals.review` action and provider the production host wires (main.ts).
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strategyDigest } from "@cashu/domain/investments/strategy";
import { mintUlid } from "@cashu/store";
import {
  createInvestmentProposal,
  DailyPriceLock,
  prepareRuleCreation,
} from "@cashu/store/investments/services";
import { expect, it } from "vitest";
import { runHostVaultCommand } from "../commands.js";
import { startLocalHost } from "../host.js";
import { storeClient } from "../testing/harness.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { nativeStrategyApprovals } from "./strategyApproval.js";
import { strategyPublicationPorts } from "./strategyFiles.js";

it("approves strategy and custom-rule proposals into the native strategy files", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  chmodSync(join(fixture.dataDir, "vaults", fixture.vaultId), 0o700);
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    strategyProposals: nativeStrategyApprovals({ dailyLock: new DailyPriceLock() }),
  });
  const client = await storeClient(fixture.dataDir);
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    const authority = vault?.native?.strategyDirectoryAuthority();
    if (vault === undefined || !authority) throw new Error("native strategy authority absent");
    // The owner's template strategy (Strategie "Z szablonu").
    const refreshed = await client.action("investments.strategies.refresh", {}, fixture.vaultId);
    const revision = (refreshed as { value?: { revision?: string } }).value?.revision;
    if (revision === undefined) throw new Error("strategy revision absent");
    expect(
      await client.action("investments.strategies.init", { revision }, fixture.vaultId),
    ).toMatchObject({ status: "completed" });
    const files = strategyPublicationPorts(authority).files;
    const directory = join(fixture.dataDir, "vaults", fixture.vaultId, "strategy");
    const onDisk = () => readFileSync(join(directory, "strategy.yaml"), "utf8");

    /** What MCP propose_strategy / propose_custom_rule store, then the owner's approve click. */
    const propose = async (
      kind: "strategy" | "custom_rule",
      payload: (base: ReturnType<typeof files.readSync>) => Record<string, unknown>,
    ) => {
      const base = files.readSync();
      const created = await runHostVaultCommand(
        vault,
        createInvestmentProposal({ ...files, read: files.readSync }, base),
        {
          kind,
          summary: `Synthetic ${kind}`,
          summaryParams: {},
          reason: null,
          payload: { ...payload(base), base_sha256: strategyDigest(base.yaml ?? "", base.md) },
        },
        mintUlid(Date.now()),
      );
      if (created.kind !== "completed") throw new Error(`proposal not created: ${created.kind}`);
      const gid = (created.value as { proposalGid: string }).proposalGid;
      return client.action(
        "core.desktopProposals.review",
        { gid, decision: "approve" },
        fixture.vaultId,
      );
    };

    const before = onDisk();
    const yaml = `${before}\n# synthetic owner-approved revision\n`;
    expect(await propose("strategy", (base) => ({ yaml, md: base.md }))).toMatchObject({
      status: "completed",
      value: { status: "approved" },
    });
    expect(onDisk()).toBe(yaml);

    // An integer parameter: a fractional one cannot be stored on a native vault yet (canonical
    // event JSON has no floats), which is a separate MCP propose_custom_rule defect.
    const rule = prepareRuleCreation(files.readSync(), "cash_level", { max_weight: 1 }).entry;
    expect(await propose("custom_rule", () => ({ rule }))).toMatchObject({
      status: "completed",
      value: { status: "approved" },
    });
    expect(onDisk()).toContain(String(rule.id));
  } finally {
    client.close();
    await host.stop();
    fixture.cleanup();
  }
});
