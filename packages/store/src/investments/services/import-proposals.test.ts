import { sha256Hex } from "@cashu/domain";
import { MAX_FILE_BYTES } from "@cashu/domain/investments/importing";
import { describe, expect, it, vi } from "vitest";
import { runCommand, storeWriter } from "../../command.js";
import { approvePrepared, createProposal, rejectProposal } from "../../core/proposal-commands.js";
import { proposalExecution } from "../../core/proposal-execution.js";
import type { Envelope } from "../../events/v1/envelope.js";
import { testEnv } from "../../testing/commands.js";
import { openTestStore } from "../../testing/store.js";
import { addBrokerageAccount } from "../commands/accounts.js";
import { commitImport } from "../commands/imports.js";
import { otherVault, vault } from "../commands/testing/fixtures.js";
import { transactions } from "../queries/transactions.js";
import { type ImportProposalDeps, prepareInvestmentImport } from "./import-proposals.js";

const FILE = new TextEncoder().encode(
  "format_version,record,date,type,currency,cash_amount\n" + "1,txn,2026-01-05,deposit,PLN,1000\n",
);

function setup(extra: Record<string, unknown> = {}) {
  const v = vault();
  const account = v.value(addBrokerageAccount, { name: "Synthetic broker", broker: "dif" }).account;
  const payload = {
    account,
    blob: { sha256: sha256Hex(FILE), ext: "csv" },
    file_name: "synthetic.csv",
    file_sha256: sha256Hex(FILE),
    importer: "cashu",
    mapping_yaml: null,
    ...extra,
  };
  const { proposalGid } = v.value(createProposal, {
    kind: "import",
    summary: "Synthetic pending import",
    reason: null,
    source: "agent",
    payload,
  });
  const snapshot = proposalExecution(v.store.read.bind(v.store), proposalGid);
  if (!snapshot) throw new Error("synthetic proposal missing");
  const read = vi.fn(async () => FILE);
  let authority = true;
  const deps: ImportProposalDeps = {
    store: v.store,
    blobs: { read },
    isHolder: () => authority,
    now: () => v.env.clock.now(),
  };
  return { v, account, payload, snapshot, deps, read, loseAuthority: () => (authority = false) };
}

async function prepared(s: ReturnType<typeof setup>) {
  const result = await prepareInvestmentImport(s.deps, s.snapshot);
  if (!result.ok) throw new Error(`synthetic preparation refused: ${result.reason}`);
  return result.value;
}

describe("ordinary investment proposal approvals", () => {
  it("appends the real approval/result and native import as one caused batch, then rebuilds", async () => {
    const s = setup();
    const effect = await prepared(s);
    const batches: (readonly Envelope[])[] = [];
    const writer = storeWriter(s.v.store);
    const out = runCommand(
      s.v.store,
      {
        append: (es) => {
          batches.push(es);
          writer.append(es);
        },
      },
      approvePrepared(effect),
      {},
      s.v.env,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(batches).toHaveLength(1);
    const approval = out.events[0];
    expect(approval?.type).toBe("proposal.approved");
    expect(out.events.slice(1).every((e) => e.cause === approval?.eid)).toBe(true);
    expect(approval?.data.result).toEqual({
      batch_id: out.value.effect.batch,
      inserted: 1,
      duplicates: 0,
      positions: 0,
      new_instruments: 0,
    });
    expect(transactions(s.v.store.read.bind(s.v.store), [s.account])).toHaveLength(1);
    expect(s.read).toHaveBeenCalledWith(s.v.store.vault, s.payload.blob, MAX_FILE_BYTES);
    s.v.store.rebuild();
    expect(proposalExecution(s.v.store.read.bind(s.v.store), s.snapshot.gid)?.result).toEqual(
      approval?.data.result,
    );
    expect(transactions(s.v.store.read.bind(s.v.store), [s.account])).toHaveLength(1);
  });

  it("re-previews the current queued data and records actual duplicates, not prepared counts", async () => {
    const s = setup();
    const effect = await prepared(s);
    s.v.value(commitImport, {
      account: s.account,
      file: { name: "synthetic.csv", content: FILE },
      importer: "cashu",
      archive: s.payload.blob,
    });
    const result = s.v.value(approvePrepared(effect), {});
    expect(result.effect.inserted).toBe(0);
    expect(result.effect.duplicates).toBe(1);
    expect(proposalExecution(s.v.store.read.bind(s.v.store), s.snapshot.gid)?.result).toMatchObject(
      { inserted: 0, duplicates: 1 },
    );
  });

  it.each(["converter", "connector", "binding", "run"])(
    "refuses %s before reading any blob",
    async (which) => {
      const extra =
        which === "converter"
          ? { converter: "never-run.py" }
          : which === "connector"
            ? { source: "connector" }
            : which === "binding"
              ? { binding_id: 7 }
              : { run_id: 9 };
      const s = setup(extra);
      expect(await prepareInvestmentImport(s.deps, s.snapshot)).toEqual({
        ok: false,
        reason: which === "converter" ? "converter_unsupported" : "connector_binding_unsupported",
      });
      expect(s.read).not.toHaveBeenCalled();
    },
  );

  it("refuses a connector importer on a proposal that is not from a connector", async () => {
    const s = setup({ importer: "connector:synthetic-broker" });
    expect(await prepareInvestmentImport(s.deps, s.snapshot)).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
    expect(s.read).not.toHaveBeenCalled();
  });

  it("checks authority before and after the blob await, even with a true scaffold lease", async () => {
    const s = setup();
    s.loseAuthority();
    expect(await prepareInvestmentImport(s.deps, s.snapshot)).toEqual({
      ok: false,
      reason: "not_leader",
    });
    expect(s.read).not.toHaveBeenCalled();
    const t = setup();
    t.read.mockImplementation(async () => {
      t.loseAuthority();
      return FILE;
    });
    expect(await prepareInvestmentImport(t.deps, t.snapshot)).toEqual({
      ok: false,
      reason: "not_leader",
    });
    expect(proposalExecution(t.v.store.read.bind(t.v.store), t.snapshot.gid)?.status).toBe(
      "pending",
    );
  });

  it("checks authority again at append and leaves approval/effects absent", async () => {
    const s = setup();
    const effect = await prepared(s);
    s.loseAuthority();
    expect(s.v.run(approvePrepared(effect), {})).toEqual({ ok: false, reason: "not_leader" });
    expect(proposalExecution(s.v.store.read.bind(s.v.store), s.snapshot.gid)?.status).toBe(
      "pending",
    );
    expect(transactions(s.v.store.read.bind(s.v.store), [s.account])).toHaveLength(0);
  });

  it("rejects missing/foreign brokerage ownership before any blob read", async () => {
    const foreign = otherVault();
    const account = foreign.value(addBrokerageAccount, {
      name: "Other synthetic",
      broker: "dif",
    }).account;
    const s = setup({ account });
    expect(await prepareInvestmentImport(s.deps, s.snapshot)).toEqual({
      ok: false,
      reason: "no_account",
    });
    expect(s.read).not.toHaveBeenCalled();
  });

  it.each(["digest", "extension", "bytes"])("refuses changed %s", async (which) => {
    const s = setup(
      which === "digest"
        ? { file_sha256: "0".repeat(64) }
        : which === "extension"
          ? { blob: { sha256: sha256Hex(FILE), ext: "json" } }
          : {},
    );
    if (which === "bytes") s.read.mockResolvedValue(new TextEncoder().encode("changed"));
    expect(await prepareInvestmentImport(s.deps, s.snapshot)).toEqual({
      ok: false,
      reason: "staged_changed",
    });
  });

  it("copies retained provider bytes and preserves class-method receivers", async () => {
    const s = setup();
    const held = Uint8Array.from(FILE);
    class Blobs {
      #bytes = held;
      async read() {
        return this.#bytes;
      }
    }
    const effect = await prepareInvestmentImport({ ...s.deps, blobs: new Blobs() }, s.snapshot);
    if (!effect.ok) throw new Error(effect.reason);
    held.fill(0);
    expect(s.v.value(approvePrepared(effect.value), {}).effect.inserted).toBe(1);
  });

  it("does not import after a concurrent rejection or accept a forged snapshot", async () => {
    const s = setup();
    const effect = await prepared(s);
    s.v.value(rejectProposal, { proposalGid: s.snapshot.gid, note: null });
    expect(s.v.run(approvePrepared(effect), {})).toEqual({ ok: false, reason: "not_pending" });
    const t = setup();
    expect(
      await prepareInvestmentImport(t.deps, {
        ...t.snapshot,
        payload: { ...t.snapshot.payload, importer: "auto" },
      }),
    ).toEqual({ ok: false, reason: "proposal_changed" });
    expect(t.read).not.toHaveBeenCalled();
  });

  it("refuses blocked previews without an approval append", async () => {
    const bytes = new TextEncoder().encode("not a broker export");
    const s = setup({
      blob: { sha256: sha256Hex(bytes), ext: "csv" },
      file_sha256: sha256Hex(bytes),
    });
    s.read.mockResolvedValue(bytes);
    expect(await prepareInvestmentImport(s.deps, s.snapshot)).toEqual({
      ok: false,
      reason: "import_blocked",
    });
    expect(proposalExecution(s.v.store.read.bind(s.v.store), s.snapshot.gid)?.status).toBe(
      "pending",
    );
  });

  it("suppresses every real import effect when an earlier offline rejection arrives, in either delivery order", async () => {
    const s = setup();
    const effect = await prepared(s);
    const base = s.v.store.foreignEvents(0, new Set(), 1000).events;
    const peer = openTestStore();
    peer.applyEnvelopes(base);
    const rejected = runCommand(
      peer,
      storeWriter(peer),
      rejectProposal,
      { proposalGid: s.snapshot.gid, note: null },
      testEnv({ device: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", seed: 2 }),
    );
    if (!rejected.ok) throw new Error(rejected.reason);
    const approved = s.v.run(approvePrepared(effect), {});
    if (!approved.ok) throw new Error(approved.reason);
    s.v.store.applyEnvelopes(rejected.events);
    peer.applyEnvelopes([...approved.events].reverse());
    for (const store of [s.v.store, peer]) {
      expect(proposalExecution(store.read.bind(store), s.snapshot.gid)?.status).toBe("rejected");
      expect(transactions(store.read.bind(store), [s.account])).toHaveLength(0);
      expect(store.read("SELECT gid FROM inv_import_batches")).toHaveLength(0);
      store.rebuild();
      expect(transactions(store.read.bind(store), [s.account])).toHaveLength(0);
    }
  });

  it("rejecting one proposal does not remove the same archived content another proposal needs", async () => {
    const s = setup();
    const second = s.v.value(createProposal, {
      kind: "import",
      summary: "Another pending import",
      reason: null,
      source: "agent",
      payload: s.payload,
    });
    s.v.value(rejectProposal, { proposalGid: s.snapshot.gid, note: null });
    const snapshot = proposalExecution(s.v.store.read.bind(s.v.store), second.proposalGid);
    if (!snapshot) throw new Error("synthetic proposal missing");
    const result = await prepareInvestmentImport(s.deps, snapshot);
    if (!result.ok) throw new Error(result.reason);
    expect(s.v.value(approvePrepared(result.value), {}).effect.inserted).toBe(1);
  });
});
