import { sha256Hex } from "@cashu/domain";
import { encodeValue } from "@cashu/host-protocol/store";
import { investmentsCommands as C, runCommand, setModules } from "@cashu/store";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { startLocalHost } from "./host.js";
import { type InvestmentImportCapability, investmentImportActions } from "./investmentsScreen.js";
import { cleanup, tempDir, testHostOptions } from "./testing/harness.js";

afterEach(cleanup);
const bytes = new TextEncoder().encode(
  "format_version,record,date,type,currency,cash_amount\n1,txn,2026-01-05,deposit,PLN,10.25\n",
);
async function fixture(cleanupFails = false) {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), python: null });
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("missing synthetic vault");
  const account = await vault.queue.run(() => {
    runCommand(vault.store, vault.writer, setModules, { moduleIds: ["investments"] }, vault.env);
    const out = runCommand(
      vault.store,
      vault.writer,
      C.addBrokerageAccount,
      { name: "Synthetic", broker: "manual", currency: "PLN" },
      vault.env,
    );
    if (!out.ok) throw new Error(out.reason);
    return out.value.account;
  });
  const staged = new Map<string, Uint8Array>();
  const archive = new Map<string, Uint8Array>();
  const remove = vi.fn(async (hash: string, ext: string) => {
    staged.delete(`${hash}.${ext}`);
  });
  let holder = true;
  const cap: InvestmentImportCapability = {
    vault: vault.id,
    generation: "synthetic",
    isCurrent: () => true,
    isHolder: () => holder,
    select: async () => ({ name: "synthetic.csv", content: bytes }),
    staging: {
      put: async (hash, ext, content) => {
        staged.set(`${hash}.${ext}`, Uint8Array.from(content));
      },
      get: async (hash, ext) => staged.get(`${hash}.${ext}`) ?? null,
      remove,
    },
    publication: {
      vault: vault.id,
      binding: {},
      isCurrent: () => true,
      publish: async (content, expected) => {
        archive.set(expected.sha256, Uint8Array.from(content));
        return { blob: expected, privateStage: {} };
      },
      read: async (_vault, blob) => archive.get(blob.sha256) ?? null,
      discardPrivateStage: async () => {
        if (cleanupFails) throw new Error("synthetic cleanup failure");
      },
    },
  };
  const manager = investmentImportActions({
    bind: (id) => (id === vault.id ? cap : null),
    now: () => Date.UTC(2026, 9, 31, 12),
  });
  const preview = manager.actions[0],
    commit = manager.actions[1];
  if (!preview || !commit) throw new Error("missing actions");
  return {
    host,
    vault,
    account,
    cap,
    manager,
    preview,
    commit,
    staged,
    archive,
    remove,
    holder: (value: boolean) => {
      holder = value;
    },
  };
}

it("two same-content previews survive one committed import and receipt cleanup failure remains success", async () => {
  const f = await fixture(true);
  try {
    const first = await f.preview.run(f.host.stores, f.vault.id, {
      account: f.account,
      importer: "cashu",
    });
    const second = await f.preview.run(f.host.stores, f.vault.id, {
      account: f.account,
      importer: "cashu",
    });
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed")
      throw new Error("preview refused");
    expect(() => encodeValue(first.value)).not.toThrow();
    expect(JSON.stringify(encodeValue(first.value))).not.toContain('"content"');
    const stage = z
      .object({ status: z.literal("previewed"), stage: z.string() })
      .parse(first.value).stage;
    const result = await f.commit.run(f.host.stores, f.vault.id, { stage });
    expect(result).toMatchObject({
      status: "completed",
      value: {
        status: "committed",
        result: { inserted: 1 },
        stagingCleanup: "retained",
        publicationCleanupFailed: true,
      },
    });
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.staged.has(`${sha256Hex(bytes)}.csv`)).toBe(true);
    expect(f.vault.store.read("SELECT gid FROM inv_import_batches")).toHaveLength(1);
  } finally {
    f.manager.close();
    await f.host.stop();
  }
});

it("reserves pending preview capacity before choosing files and cancellation creates no stage or event", async () => {
  const f = await fixture();
  let release: (value: null) => void = () => {};
  const pending = new Promise<null>((resolve) => {
    release = resolve;
  });
  const select = vi.fn(() => pending);
  f.cap.select = select;
  try {
    const attempts = Array.from({ length: 9 }, () =>
      f.preview.run(f.host.stores, f.vault.id, { account: f.account }),
    );
    expect(await attempts[8]).toMatchObject({ status: "refused", reason: "busy" });
    await expect.poll(() => select.mock.calls.length).toBe(8);
    release(null);
    expect(
      (await Promise.all(attempts)).filter((result) => result.status === "completed"),
    ).toHaveLength(8);
    expect(f.staged.size).toBe(0);
    expect(f.vault.store.read("SELECT gid FROM inv_import_batches")).toHaveLength(0);
  } finally {
    release(null);
    f.manager.close();
    await f.host.stop();
  }
});
