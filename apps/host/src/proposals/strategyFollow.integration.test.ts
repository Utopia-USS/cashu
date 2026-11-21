// Strategy files across two devices of one vault (events.md 8.8, store strategyFileSync.ts): each
// device has its own private strategy directory (the real pinned file adapter) and its own store,
// and the devices exchange their logs through real sync engines over a shared memory transport.
// The leader's daily run must never re-record its older files over a version approved on another
// device; files follow the recorded version; conflicting edits survive as proposals. Synthetic data.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { strategyDigest } from "@cashu/domain/investments/strategy";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  type Command,
  investmentsCommands,
  metaClockStore,
  prepareCommand,
  Store,
  toUnstampedEvent,
  vaultSalt,
} from "@cashu/store";
import {
  createProposal,
  executePreparedApproval,
  ProposalApplyingLock,
  proposalExecution,
} from "@cashu/store/core";
import { latestStrategyVersion, strategyVersions } from "@cashu/store/investments/queries";
import {
  DailyPriceLock,
  loadStrategy,
  prepareStrategyApproval,
  syncStrategyFiles,
} from "@cashu/store/investments/services";
import { createSyncEngine } from "@cashu/sync";
import {
  insecureTestCodec,
  insecureTestGate,
  ManualClock,
  MemoryTransport,
} from "@cashu/sync/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "../testing/harness.js";
import { testStrategyDirs } from "../testing/strategyDirs.js";

afterEach(cleanup);

const VAULT = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const LEADER = "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const V1 = "version: 1\nbase_currency: PLN\n";
const V2 = "version: 1\nbase_currency: EUR\n";
const V3 = "version: 1\nbase_currency: USD\n";
const EDIT = "version: 1\nbase_currency: CHF\n";

async function device(id: string, remote: MemoryTransport, clock: ManualClock) {
  const store = Store.open({
    driver: openNodeSqlite(":memory:"),
    vault: VAULT,
    salt: vaultSalt(SALT),
    modules: builtinModules(),
  });
  const engine = await createSyncEngine({
    vault: VAULT,
    device: id,
    local: new MemoryTransport(),
    remotes: [remote],
    codec: insecureTestCodec(),
    gate: insecureTestGate(),
    sink: store.sink(),
    clockStore: metaClockStore(store.driver, id),
    physicalClock: clock,
  });
  const dirs = testStrategyDirs();
  const ports = dirs.strategySync(VAULT);
  const directory = dirs.directory(VAULT);
  const env = { device: id, clock, lease: { isHolder: () => true } };
  /** A command appended through this device's sync engine (as the native vault does). */
  const exec = async <I, R>(command: Command<I, R>, input: unknown): Promise<R> => {
    clock.set(clock.now() + 1000);
    const out = prepareCommand(store, command, input, env);
    if (!out.ok) throw new Error(out.reason);
    await engine.write(out.events.map(toUnstampedEvent));
    return out.value;
  };
  const durableWrite = async <I, R>(command: Command<I, R>, input: unknown) => {
    try {
      return { kind: "completed" as const, value: await exec(command, input), eids: [] };
    } catch (error) {
      return { kind: "refused" as const, reason: (error as Error).message };
    }
  };
  return {
    store,
    engine,
    ports,
    files: dirs.files(VAULT),
    read: store.read.bind(store),
    /** The owner edits this device's strategy.yaml outside the app. */
    edit(yaml: string) {
      writeFileSync(join(directory, "strategy.yaml"), yaml, { mode: 0o600 });
    },
    yaml: async () => (await ports.files.read()).yaml,
    /** The leader's daily run: the strategy load with recording, as `runDaily` does it. */
    daily: () =>
      loadStrategy(store, dirs.files(VAULT), {
        record: true,
        writer: {
          append: () => {
            throw new Error("native writes go through the engine");
          },
        },
        env: { ...env, hlc: undefined as never },
        sync: ports,
        durableWrite,
      }),
    /** The background follower after a sync pass (host strategyFollow.ts). */
    follow: () =>
      syncStrategyFiles({
        store,
        files: ports.files,
        journal: ports.journal,
        isVaultCurrent: () => true,
        record: (input) => exec(investmentsCommands.saveStrategyVersion, input),
        propose: async (input) => {
          await exec(createProposal, input);
        },
      }),
    /** The owner approves a strategy proposal on this device (host strategyApproval.ts). */
    async approve(proposalGid: string) {
      await this.follow();
      const snapshot = proposalExecution(store.read.bind(store), proposalGid);
      if (snapshot === undefined) throw new Error("synthetic proposal absent");
      const prepared = await prepareStrategyApproval({
        store,
        files: ports.files,
        journal: ports.journal,
        isVaultCurrent: () => true,
        proposal: snapshot,
      });
      return executePreparedApproval(
        {
          store,
          writer: {
            append: () => {
              throw new Error("native writes go through the engine");
            },
          },
          env: { ...env, hlc: undefined as never },
          dailyLock: new DailyPriceLock(),
          applyingLock: new ProposalApplyingLock(),
          runWrite: async (work) => work(),
          runDurable: async (command, input) => durableWrite(command, input),
          isVaultCurrent: () => true,
          isHolder: () => false,
        },
        prepared.effect,
        prepared.publication,
      );
    },
    exec,
  };
}

async function twoDevices() {
  const remote = new MemoryTransport();
  const clock = new ManualClock(Date.UTC(2026, 10, 8, 9));
  const leader = await device(LEADER, remote, clock);
  const second = await device(SECOND, remote, clock);
  /** Both devices push and pull until each has the other's events. */
  const sync = async () => {
    await leader.engine.sync();
    await second.engine.sync();
    await leader.engine.sync();
  };
  return { leader, second, sync };
}

/** The recorded strategy texts, oldest first. */
const yamls = (read: Store["read"]) =>
  strategyVersions(read)
    .map((v) => v.yamlText)
    .reverse();

describe("strategy files on two devices", () => {
  it("a version approved on the second device is not undone by the leader's daily run", async () => {
    const { leader, second, sync } = await twoDevices();
    leader.edit(V1);
    await leader.daily();
    await sync();
    expect(await second.follow()).toMatchObject({ status: "followed" });
    expect(await second.yaml()).toBe(V1);
    // The agent proposes a new strategy over the current files; the owner approves it on the
    // second device, which records version 2 and writes its own files.
    const { proposalGid } = await second.exec(createProposal, {
      kind: "strategy",
      summary: "Synthetic strategy",
      reason: null,
      source: "agent",
      payload: { yaml: V2, md: null, base_sha256: strategyDigest(V1, null) },
    });
    expect(await second.approve(proposalGid)).toMatchObject({ status: "approved" });
    expect(await second.yaml()).toBe(V2);
    await sync();
    // The leader's files still hold version 1: its daily run must follow version 2, not record
    // its old text as version 3.
    const state = await leader.daily();
    expect(yamls(leader.read)).toEqual([V1, V2]);
    expect(state.version?.yamlText).toBe(V2);
    expect(await leader.yaml()).toBe(V2);
    await sync();
    expect(yamls(second.read)).toEqual([V1, V2]);
    // A genuine edit on the leader on top of version 2 is recorded with its base.
    leader.edit(V3);
    await leader.daily();
    await sync();
    expect(await second.follow()).toMatchObject({ status: "followed" });
    expect(await second.yaml()).toBe(V3);
    expect(yamls(second.read)).toEqual([V1, V2, V3]);
  });

  it("an edit made on a device whose files were behind becomes a proposal, never lost", async () => {
    const { leader, second, sync } = await twoDevices();
    leader.edit(V1);
    await leader.daily();
    await sync();
    await second.follow();
    // Offline: the owner edits the second device's files while the leader records version 2.
    second.edit(EDIT);
    leader.edit(V2);
    await leader.daily();
    await sync();
    const result = await second.follow();
    expect(result).toMatchObject({ status: "conflict", proposed: true });
    // The later recorded version stays current on both devices and the files follow it.
    expect(await second.yaml()).toBe(V2);
    expect(latestStrategyVersion(second.read)?.yamlText).toBe(V2);
    const pending = second.read<{ gid: string }>(
      "SELECT gid FROM proposals WHERE status = 'pending'",
    );
    expect(pending).toHaveLength(1);
    const proposal = proposalExecution(second.read, pending[0]?.gid ?? "");
    expect(proposal?.payload).toMatchObject({
      yaml: EDIT,
      base_sha256: strategyDigest(V2, null),
      conflict: "local_edit",
    });
    // The owner approves the kept edit: it becomes version 3 over version 2, on both devices.
    await sync();
    expect(await leader.approve(proposal?.gid ?? "")).toMatchObject({ status: "approved" });
    await sync();
    await second.follow();
    expect(yamls(second.read)).toEqual([V1, V2, EDIT]);
    expect(await second.yaml()).toBe(EDIT);
    expect(await leader.yaml()).toBe(EDIT);
  });

  it("two versions recorded concurrently keep the later one and propose the other once", async () => {
    const { leader, second, sync } = await twoDevices();
    leader.edit(V1);
    await leader.daily();
    await sync();
    await second.follow();
    // Offline on both: each device records its own edit on top of version 1.
    leader.edit(V2);
    await leader.daily();
    second.edit(V3);
    expect(await second.follow()).toMatchObject({ status: "recorded" });
    await sync();
    // The second device's version sorts later (its clock is ahead): it is current everywhere.
    expect(latestStrategyVersion(leader.read)?.yamlText).toBe(V3);
    expect(latestStrategyVersion(second.read)?.yamlText).toBe(V3);
    // The leader authored the superseded version: it proposes its text and follows.
    expect(await leader.follow()).toMatchObject({ status: "conflict", proposed: true });
    expect(await leader.yaml()).toBe(V3);
    expect(await second.follow()).toMatchObject({ status: "in_sync" });
    await sync();
    for (const d of [leader, second]) {
      expect(await d.follow()).toMatchObject({ status: "in_sync" });
      const pending = d.read<{ gid: string }>("SELECT gid FROM proposals WHERE status = 'pending'");
      expect(pending).toHaveLength(1);
      expect(proposalExecution(d.read, pending[0]?.gid ?? "")?.payload).toMatchObject({
        yaml: V2,
        base_sha256: strategyDigest(V3, null),
        conflict: "concurrent_version",
      });
    }
  });
});
