/** New orchestration over actual host queues/commands, with bounded synthetic file capabilities. */

import { setModules } from "@cashu/store";
import type { StrategyDocsDir, StrategyFilesPort } from "@cashu/store/investments/services";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { type StrategyScreenCapability, strategiesScreen } from "./strategiesScreen.js";
import { cleanup, tempDir, testHostOptions } from "./testing/harness.js";
import { command } from "./testing/worker.js";

afterEach(cleanup);
async function fixture(empty = false) {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("synthetic vault absent");
  await command(vault, setModules, { moduleIds: ["investments"] });
  const texts = new Map<string, string>(
    empty
      ? []
      : [
          ["strategy.yaml", "version: 1\nbase_currency: PLN\n"],
          ["strategy.md", "# Synthetic current document\n"],
        ],
  );
  let active = true;
  let create: StrategyScreenCapability["createAbsent"];
  const files: StrategyFilesPort = {
    read: async (name) => texts.get(name) ?? null,
    exists: async (name) => texts.has(name),
    async write() {
      throw new Error("unsafe_replace_forbidden");
    },
  };
  const documents: StrategyDocsDir = {
    async list(parts) {
      return parts.length === 0
        ? [...texts].map(([name, text]) => ({ name, kind: "file" as const, size: text.length }))
        : null;
    },
    async readText(parts) {
      return texts.get(parts.join("/")) ?? null;
    },
  };
  const cap: StrategyScreenCapability = {
    vault: vault.id,
    generation: "synthetic-lifetime",
    files,
    documents,
    get createAbsent() {
      return create;
    },
    isCurrent: () => active,
  };
  const make = () => strategiesScreen({ bind: () => cap, publish: () => active, revoke() {} });
  const manager = make();
  await manager.prepare(vault.id);
  const revision = () =>
    manager.source.current(vault.store.read.bind(vault.store))?.revision ?? "absent";
  const run = (id: string, input = { revision: revision() }) => {
    const action = manager.actions.find((a) => a.id === `investments.strategies.${id}`);
    if (!action) throw new Error("missing action");
    return action.run(host.stores, vault.id, input);
  };
  return {
    host,
    vault,
    texts,
    cap,
    manager,
    make,
    revision,
    run,
    revoke() {
      active = false;
    },
    creator(value: NonNullable<typeof create>) {
      create = value;
    },
  };
}
describe("strategy UI action boundaries", () => {
  it("records actual files once and an explicit reload deduplicates", async () => {
    const f = await fixture();
    try {
      expect(await f.run("reload")).toMatchObject({
        status: "completed",
        value: { status: "recorded", version: 1 },
      });
      expect(await f.run("reload")).toMatchObject({
        status: "completed",
        value: { status: "unchanged", version: 1 },
      });
      expect(f.vault.store.read("SELECT gid FROM inv_strategy_versions")).toHaveLength(1);
    } finally {
      f.manager.close();
      await f.host.stop();
    }
  });
  it("refuses an edited file image before any append", async () => {
    const f = await fixture();
    try {
      const revision = f.revision();
      f.texts.set("strategy.yaml", "version: 2\n");
      expect(await f.run("reload", { revision })).toMatchObject({
        status: "refused",
        reason: "stale_revision",
      });
      expect(f.vault.store.read("SELECT gid FROM inv_strategy_versions")).toHaveLength(0);
    } finally {
      f.manager.close();
      await f.host.stop();
    }
  });
  it("init stays unavailable without a genuine create-if-absent capability", async () => {
    const f = await fixture(true);
    try {
      expect(await f.run("init")).toMatchObject({
        status: "refused",
        reason: "capability_unavailable",
      });
      expect(f.texts.size).toBe(0);
    } finally {
      f.manager.close();
      await f.host.stop();
    }
  });
  it("preserves a concurrently created owner file and the known first created target", async () => {
    const f = await fixture(true);
    f.creator({
      async create(name, text) {
        if (name === "strategy.md") f.texts.set(name, "# Concurrent owner document");
        if (f.texts.has(name)) return { status: "exists" };
        f.texts.set(name, text);
        return { status: "created" };
      },
    });
    try {
      expect(await f.run("init")).toMatchObject({
        status: "completed",
        value: { status: "partial_files", reason: "files_exist", written: ["strategy.yaml"] },
      });
      expect(f.texts.get("strategy.md")).toBe("# Concurrent owner document");
      expect(f.texts.has("strategy.yaml")).toBe(true);
      expect(f.vault.store.read("SELECT gid FROM inv_strategy_versions")).toHaveLength(0);
    } finally {
      f.manager.close();
      await f.host.stop();
    }
  });
  it("two independent preparations use the final queued strategy dedup primitive", async () => {
    const f = await fixture();
    const second = f.make();
    try {
      await second.prepare(f.vault.id);
      const revision = second.source.current(f.vault.store.read.bind(f.vault.store))?.revision;
      const action = second.actions.find((a) => a.id === "investments.strategies.reload");
      if (!action || !revision) throw new Error("synthetic preparation missing");
      const results = await Promise.all([
        f.run("reload"),
        action.run(f.host.stores, f.vault.id, { revision }),
      ]);
      expect(
        results
          .map((r) =>
            r.status === "completed" ? (r.value as { status: string }).status : r.status,
          )
          .sort(),
      ).toEqual(["recorded", "unchanged"]);
      expect(f.vault.store.read("SELECT gid FROM inv_strategy_versions")).toHaveLength(1);
    } finally {
      second.close();
      f.manager.close();
      await f.host.stop();
    }
  });
  it("keeps the host queue available during file awaits and refuses module-disabled append", async () => {
    const f = await fixture();
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.cap.files.read.bind(f.cap.files);
    let once = true;
    f.cap.files.read = async (name) => {
      if (once) {
        once = false;
        entered();
        await gate;
      }
      return original(name);
    };
    try {
      const work = f.run("reload");
      await ready;
      await command(f.vault, setModules, { moduleIds: [] });
      release();
      expect(await work).toMatchObject({ status: "refused" });
      expect(f.vault.store.read("SELECT gid FROM inv_strategy_versions")).toHaveLength(0);
    } finally {
      release();
      f.manager.close();
      await f.host.stop();
    }
  });
  it("full files followed by an ambiguous record failure remain unknown", async () => {
    const f = await fixture(true);
    f.creator({
      async create(name, text) {
        if (f.texts.has(name)) return { status: "exists" };
        f.texts.set(name, text);
        return { status: "created" };
      },
    });
    const append = f.vault.writer.append;
    f.vault.writer.append = () => {
      throw new Error("synthetic append failure");
    };
    try {
      expect(await f.run("init")).toMatchObject({
        status: "outcome_unknown",
        reason: "interrupted",
      });
      expect(f.texts.size).toBe(2);
      expect(f.vault.store.read("SELECT gid FROM inv_strategy_versions")).toHaveLength(0);
    } finally {
      f.vault.writer.append = append;
      f.manager.close();
      await f.host.stop();
    }
  });
});
