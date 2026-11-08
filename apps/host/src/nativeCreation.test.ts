import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import type { createProductionKeyStore } from "@cashu/node-host/keyring";
import { createTestKeyStore, type OsKeyringPort } from "@cashu/node-host/testing";
import {
  type Command,
  prepareCommand,
  renameProfile,
  setModules,
  setProfileSettings,
  toUnstampedEvent,
} from "@cashu/store";
import { crypto } from "@cashu/sync";
import { afterEach, expect, it, vi } from "vitest";
import { takeWriterLease } from "./lease.js";
import { createNativeCreationService } from "./nativeCreation.js";
import {
  type CreationStage,
  classifyNativeCreationStartup,
  NativeCreationJournal,
  readNativeCreationJournal,
} from "./nativeCreationJournal.js";
import { verifyCompletedNativeCreation } from "./nativeCreationProof.js";
import { openNativeVault } from "./nativeVault.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("keeps the original Create ready after legitimate profile, module and privacy edits", async () => {
  const f = await fixture();
  try {
    const creation = f.create();
    const prepared = await creation.prepare(input);
    if (prepared.kind !== "prepared") throw new Error("prepare refused in synthetic fixture");
    const ready = await creation.commit({
      operationId: prepared.operationId,
      phraseSession: prepared.phraseSession,
    });
    if (ready.kind !== "ready") throw new Error("create did not commit in synthetic fixture");
    const factory = new ProductionVaultSourceFactory(f.dataDir, f.createKeyStore);
    factory.preflight();
    const source = await factory.open(f.lock);
    const entry = source.inventory.find((candidate) => candidate.vaultId === ready.vaultId);
    if (!entry) throw new Error("new vault missing from synthetic inventory");
    const session = await openNativeVault(
      entry,
      f.dataDir,
      source,
      takeWriterLease(f.lock),
      Date.now,
    );
    try {
      const append = async <I, R>(command: Command<I, R>, value: unknown) => {
        const decided = prepareCommand(session.store, command, value, {
          device: entry.deviceId,
          clock: { now: Date.now },
          lease: { isHolder: () => false },
        });
        if (!decided.ok) throw new Error(`synthetic edit refused: ${decided.reason}`);
        await session.engine.write(decided.events.map(toUnstampedEvent));
      };
      await append(renameProfile, { name: "Edited" });
      await append(setProfileSettings, { mcpPrivacy: "amounts" });
      await append(setModules, { moduleIds: ["assets"] });
    } finally {
      await session.close();
    }
    const restarted = f.create();
    await restarted.primeVerifiedCompleted();
    expect(await restarted.current({})).toEqual(ready);
    expect(await restarted.inspect({ operationId: ready.operationId })).toEqual(ready);
  } finally {
    f.lock.release();
  }
});

const input = {
  name: "Synthetic",
  slug: "synthetic",
  baseCurrency: "PLN" as const,
  modules: ["budget"] as ["budget"],
  mcpPrivacy: "strict" as const,
};

async function fixture() {
  const outer = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "t44-test-")));
  roots.push(outer);
  const dataDir = join(outer, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(dataDir, "run"), { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("test lock unavailable");
  const items = new Map<string, Uint8Array>();
  const port: OsKeyringPort = {
    async get(service, account) {
      return items.get(`${service}/${account}`)?.slice() ?? null;
    },
    async set(service, account, value) {
      items.set(`${service}/${account}`, value.slice());
    },
  };
  const service = `cashu-next-test.${randomBytes(16).toString("hex")}`;
  const createKeyStore: typeof createProductionKeyStore = (options) =>
    createTestKeyStore({ ...options, service, keyring: port });
  const sodium = await crypto.loadNodeSodium();
  return {
    dataDir,
    lock,
    items,
    createKeyStore,
    sodium,
    create: (faultAfterPhase?: (stage: CreationStage) => void) =>
      createNativeCreationService({
        dataDir,
        lock,
        sodium,
        createKeyStore,
        ...(faultAfterPhase ? { faultAfterPhase } : {}),
      }),
  };
}

it("creates one genuine encrypted profile and reconciles a completed operation read-only", async () => {
  const f = await fixture();
  try {
    expect(classifyNativeCreationStartup(f.dataDir)).toBe("setup");
    const creation = f.create();
    const prepared = await creation.prepare(input);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;
    expect(prepared.words.split(" ")).toHaveLength(24);
    expect(readNativeCreationJournal(f.dataDir).pending).toBeNull();
    expect(f.items.size).toBe(0);
    const committed = await creation.commit({
      operationId: prepared.operationId,
      phraseSession: prepared.phraseSession,
    });
    expect(committed.kind).toBe("ready");
    if (committed.kind !== "ready") return;
    expect(classifyNativeCreationStartup(f.dataDir)).toBe("ready");
    const anchor = readNativeCreationJournal(f.dataDir).completed[0];
    if (!anchor) throw new Error("missing completed anchor");
    expect(
      await verifyCompletedNativeCreation(f.dataDir, f.lock, anchor, f.createKeyStore, Date.now),
    ).toBe(true);
    expect(await creation.current({})).toEqual(committed);
    expect(await creation.inspect({ operationId: prepared.operationId })).toEqual(committed);
    expect(readNativeCreationJournal(f.dataDir).completed).toHaveLength(1);
    const restarted = f.create();
    await restarted.primeVerifiedCompleted();
    expect(await restarted.current({})).toEqual(committed);
    expect(f.items.size).toBe(1);
  } finally {
    f.lock.release();
  }
});

it("expires a memory-only phrase after ten elapsed minutes despite wall-clock rollback", async () => {
  const f = await fixture();
  let wall = Date.UTC(2026, 10, 3, 12);
  vi.useFakeTimers();
  try {
    const creation = createNativeCreationService({
      dataDir: f.dataDir,
      lock: f.lock,
      sodium: f.sodium,
      createKeyStore: f.createKeyStore,
      now: () => wall,
    });
    const prepared = await creation.prepare(input);
    if (prepared.kind !== "prepared") throw new Error("prepare refused in synthetic fixture");
    wall -= 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(
      await creation.commit({
        operationId: prepared.operationId,
        phraseSession: prepared.phraseSession,
      }),
    ).toEqual({ kind: "refused", code: "prepare_missing" });
    expect(readNativeCreationJournal(f.dataDir).pending).toBeNull();
    expect(f.items.size).toBe(0);
  } finally {
    f.lock.release();
  }
});

it.each(["recorded", "keys", "artifacts", "history", "admission", "publishing"] as const)(
  "keeps a durable unknown after a %s phase fault without preparing another vault",
  async (phase) => {
    const f = await fixture();
    try {
      const creation = f.create((stage) => {
        if (stage === phase) throw new Error("synthetic_phase_fault");
      });
      const prepared = await creation.prepare(input);
      if (prepared.kind !== "prepared") throw new Error("prepare refused in synthetic fixture");
      const result = await creation.commit({
        operationId: prepared.operationId,
        phraseSession: prepared.phraseSession,
      });
      expect(result).toEqual({
        kind: "outcome_unknown",
        operationId: prepared.operationId,
        stage: phase,
      });
      expect(readNativeCreationJournal(f.dataDir).pending?.operationId).toBe(prepared.operationId);
      expect((await f.create().prepare(input)).kind).toBe("refused");
      expect(await f.create().current({})).toEqual(result);
    } finally {
      f.lock.release();
    }
  },
);

it("replaces only an uncommitted ephemeral preparation and keeps pending crash state", async () => {
  const f = await fixture();
  try {
    const creation = f.create();
    const first = await creation.prepare(input);
    const second = await creation.prepare(input);
    expect(first.kind).toBe("prepared");
    expect(second.kind).toBe("prepared");
    if (first.kind !== "prepared" || second.kind !== "prepared") return;
    expect(first.operationId).not.toBe(second.operationId);
    expect(
      await creation.commit({ operationId: first.operationId, phraseSession: first.phraseSession }),
    ).toEqual({ kind: "refused", code: "operation_conflict" });
    expect(readNativeCreationJournal(f.dataDir).pending).toBeNull();
    const journalPath = join(f.dataDir, "native", "v1", "creation.json");
    mkdirSync(join(f.dataDir, "native"), { mode: 0o700 });
    mkdirSync(join(f.dataDir, "native", "v1"), { mode: 0o700 });
    writeFileSync(
      journalPath,
      JSON.stringify({
        format: 1,
        nextSequence: 1,
        pending: {
          operationId: second.operationId,
          vaultId: "a".repeat(32),
          deviceId: "b".repeat(32),
          inputHash: "c".repeat(64),
          stage: "keys",
        },
        completed: [],
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(f.dataDir, "native", "v1", `.creation-${"d".repeat(32)}.tmp`), "partial", {
      mode: 0o600,
    });
    writeFileSync(join(f.dataDir, "native", "v1", `.inventory-${"e".repeat(32)}.tmp`), "partial", {
      mode: 0o600,
    });
    expect(classifyNativeCreationStartup(f.dataDir)).toBe("pending");
    expect(await f.create().current({})).toEqual({
      kind: "outcome_unknown",
      operationId: second.operationId,
      stage: "keys",
    });
    expect((await creation.prepare(input)).kind).toBe("refused");
    expect(readFileSync(journalPath, "utf8")).toContain('"stage":"keys"');
  } finally {
    f.lock.release();
  }
});

it("refuses orphan secret blobs and full journals before any new target is written", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.dataDir, "vault-secrets"), { mode: 0o700 });
    mkdirSync(join(f.dataDir, "vault-secrets", "v1"), { mode: 0o700 });
    writeFileSync(join(f.dataDir, "vault-secrets", "v1", "orphan"), "sealed", { mode: 0o600 });
    expect(() => classifyNativeCreationStartup(f.dataDir)).toThrow("native_creation_ambiguous");
    rmSync(join(f.dataDir, "vault-secrets"), { recursive: true });
    const version = join(f.dataDir, "native", "v1");
    mkdirSync(join(f.dataDir, "native"), { mode: 0o700 });
    mkdirSync(version, { mode: 0o700 });
    const completed = Array.from({ length: 64 }, (_, index) => ({
      sequence: index + 1,
      operationId: index.toString(16).padStart(32, "0"),
      vaultId: (index + 100).toString(16).padStart(32, "0"),
      deviceId: (index + 200).toString(16).padStart(32, "0"),
      inputHash: "a".repeat(64),
      profileSlug: "synthetic",
      eventCount: 1,
      pinEid: "0".repeat(26),
      effectHash: "b".repeat(64),
    }));
    writeFileSync(
      join(version, "creation.json"),
      JSON.stringify({
        format: 1,
        nextSequence: 65,
        pending: null,
        completed,
      }),
      { mode: 0o600 },
    );
    const journal = new NativeCreationJournal(f.dataDir, f.lock);
    expect(() =>
      journal.begin({
        operationId: "f".repeat(32),
        vaultId: "e".repeat(32),
        deviceId: "d".repeat(32),
        inputHash: "c".repeat(64),
      }),
    ).toThrow("native_creation_journal_full");
  } finally {
    f.lock.release();
  }
});
