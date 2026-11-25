import { parseDateTime } from "@cashu/domain";
import { market } from "@cashu/domain/investments";
import { strategyTemplate } from "@cashu/domain/investments/strategy";
import { decodeValue, encodeValue, type JsonValue } from "@cashu/host-protocol/store";
import { runCommand, setModules } from "@cashu/store";
import { researchScreenQueries } from "@cashu/store/investments/research-screen";
import { strategySnapshot } from "@cashu/store/investments/screen-sources";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { researchScreenSources } from "./researchScreen.js";
import { cleanup, tempDir, testHostOptions } from "./testing/harness.js";

afterEach(cleanup);

it("checks source identity and invalidates only a live injected image", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()) });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    let current = true;
    const source = researchScreenSources((gid) =>
      gid === vault.id
        ? {
            vault: vault.id,
            generation: "synthetic",
            isCurrent: () => current,
            workspace: {
              revision: "one",
              info: {
                path: "/synthetic/workspace",
                exists: true,
                skillInstalled: true,
                command: "synthetic command",
                routine: null,
              },
            },
          }
        : null,
    );
    let changes = 0;
    const stop = source.workspace?.changes.subscribe(() => {
      changes += 1;
    });
    const read = vault.store.read.bind(vault.store);
    expect(source.workspace?.current(read)).toMatchObject({
      status: "current",
      value: { vault: vault.id, generation: "synthetic", revision: "one" },
    });
    source.changed();
    expect(changes).toBe(1);
    current = false;
    expect(source.workspace?.current(read)).toMatchObject({
      status: "unavailable",
      reason: "capability_unavailable",
    });
    stop?.();
    source.close();
  } finally {
    await host.stop();
  }
});

it("encodes a genuine Research query result from current store sources", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()) });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    await vault.queue.run(() => {
      const result = runCommand(
        vault.store,
        vault.writer,
        setModules,
        { moduleIds: ["investments"] },
        vault.env,
      );
      if (!result.ok) throw new Error(result.reason);
    });
    const template = strategyTemplate("passive_etf");
    if (!template) throw new Error("missing synthetic strategy template");
    const query = researchScreenQueries({
      clock: {
        current: () => ({ now: parseDateTime("2026-10-31T12:00:00Z"), timeZone: "Europe/Warsaw" }),
      },
      strategy: {
        changes: { subscribe: () => () => {} },
        current: (read) =>
          strategySnapshot(read, {
            vault: vault.id,
            generation: "synthetic",
            revision: "one",
            files: { yaml: template.yaml, md: template.markdown, readError: null },
          }),
      },
      market: {
        changes: { subscribe: () => () => {} },
        current: () => ({ prices: new market.InMemoryPriceCache() }),
        newestRateDate: () => null,
      },
    }).screen;
    const result = query.run(vault.store.read.bind(vault.store), {
      today: "2026-10-31",
      lang: "en",
    });
    expect(result.status).toBe("current");
    const decoded = decodeValue(JSON.parse(JSON.stringify(encodeValue(result))) as JsonValue);
    expect(decoded).toMatchObject({ status: "current" });
  } finally {
    await host.stop();
  }
});
