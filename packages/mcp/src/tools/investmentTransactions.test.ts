/** Rows typed in from chat: value-free validation, the same import proposal, dedup on re-propose. */
import { sha256Hex } from "@cashu/domain";
import { investmentsCommands as C, setProfileSettings } from "@cashu/store";
import { approvePrepared, proposalExecution } from "@cashu/store/core";
import { transactions } from "@cashu/store/investments/queries";
import { type ImportPublication, prepareInvestmentImport } from "@cashu/store/investments/services";
import { afterEach, describe, expect, it } from "vitest";
import { decodeEntityRef, encodeEntityRef } from "../runtime/refs.js";
import { NativeMcpServer } from "../runtime/server.js";
import { asyncFixture } from "../testing/async.js";
import { investmentTransactionsAdapter } from "./investmentImportProposal.js";
import { investmentTools } from "./investments.js";
import { investmentWriteTools } from "./investmentWrites.js";

// Synthetic values; distinctive so a leak would be visible in the serialized answer.
const ROWS = [
  { date: "2026-11-10", type: "deposit", currency: "EUR", cash_amount: "4321.09" },
  {
    date: "2026-11-12",
    time: "10:15",
    type: "buy",
    isin: "IE00B4L5Y983",
    symbol: "IWDA",
    exchange: "XAMS",
    quantity: "7",
    price: "98.76",
    currency: "EUR",
    fee: 1.23,
  },
];
const VALUES = ["4321", "98.76", "1.23", "IE00B4L5Y983"];
const serialized = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));

const opened: ReturnType<typeof asyncFixture>[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.f.close();
});
function setup() {
  const s = asyncFixture();
  opened.push(s);
  const account = s.f.run(C.addBrokerageAccount, { name: "Synthetic broker", broker: "dif" });
  if (!account.ok) throw new Error(account.reason);
  let puts = 0;
  const blobs = new Map<string, Uint8Array>(),
    stages = new Set<object>();
  const publication: ImportPublication = {
    vault: s.f.vault,
    binding: Object.freeze({}),
    isCurrent: () => true,
    async publish(content, expected) {
      puts++;
      const stage = Object.freeze({});
      stages.add(stage);
      const blob = { sha256: sha256Hex(content), ext: expected.ext };
      blobs.set(blob.sha256, Uint8Array.from(content));
      return { blob, privateStage: stage };
    },
    async read(_vault, blob) {
      const bytes = blobs.get(blob.sha256);
      return bytes ? Uint8Array.from(bytes) : null;
    },
    async discardPrivateStage(receipt) {
      stages.delete(receipt);
    },
  };
  s.services({ investmentAsync: { vault: s.f.vault, imports: publication } });
  const server = new NativeMcpServer(
    s.runtime,
    [...investmentTools(), ...investmentWriteTools()],
    [investmentTransactionsAdapter],
  );
  const ref = encodeEntityRef("account", account.value.account);
  const proposals = () =>
    s.f.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM proposals")[0]?.n ?? -1;
  const approve = async (proposalRef: string) => {
    const snapshot = proposalExecution(
      s.f.store.read.bind(s.f.store),
      decodeEntityRef("proposal", proposalRef),
    );
    if (!snapshot) throw new Error("missing native proposal");
    const prepared = await prepareInvestmentImport(
      {
        store: s.f.store,
        blobs: publication,
        isHolder: (vault) => vault === s.f.vault && s.f.env.lease.isHolder(),
        now: s.f.env.clock.now,
      },
      snapshot,
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(s.f.run(approvePrepared(prepared.value), {}).ok).toBe(true);
    return snapshot;
  };
  return { ...s, server, ref, account: account.value.account, puts: () => puts, proposals, approve };
}

describe("validate_transactions", () => {
  it("checks rows with the import rules and previews them against the account", async () => {
    const s = setup();
    const bare = await s.server.call("validate_transactions", { rows: ROWS });
    expect(bare.ok).toBe(true);
    expect(bare.data).toMatchObject({ ok: true, rows: 2n, transactions: 2n, errors: 0n });
    expect(bare.data).not.toHaveProperty("preview");
    const withAccount = await s.server.call("validate_transactions", { rows: ROWS, account: s.ref });
    expect(withAccount.data).toMatchObject({
      ok: true,
      preview: { can_commit: true, new: 2n, duplicates: 0n, new_instruments: 1n },
    });
    expect(s.puts()).toBe(0);
    expect(s.proposals()).toBe(0);
  });
  it("reports row errors by kind without echoing values", async () => {
    const s = setup();
    const result = await s.server.call("validate_transactions", {
      rows: [{ date: "2026-11-12", type: "buy", isin: "IE00B4L5Y983", currency: "EUR", price: "98.76" }],
      account: s.ref,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ ok: false, preview: { can_commit: false } });
    expect((result.data as { errors: bigint }).errors).toBeGreaterThan(0n);
    for (const value of VALUES) expect(serialized(result.data)).not.toContain(value);
  });
  it.each([
    ["an empty list", []],
    ["a broker id", [{ ...ROWS[0], external_ref: "X-1" }]],
    ["an unknown field", [{ ...ROWS[0], amount: "1" }]],
    ["an unknown type", [{ ...ROWS[0], type: "gift" }]],
    ["a missing currency", [{ date: "2026-11-10", type: "deposit", cash_amount: "1" }]],
    ["a non-object row", ["2026-11-10,deposit"]],
    ["an exponent number", [{ ...ROWS[0], cash_amount: 1e-9 }]],
  ])("refuses %s as an argument error", async (_name, rows) => {
    const s = setup();
    for (const tool of ["validate_transactions", "propose_transactions"]) {
      const result = await s.server.call(tool, { rows, account: s.ref });
      expect(result.ok).toBe(false);
      expect(result.errorKind).toBe("invalid_arguments");
      expect(serialized(result)).not.toContain("X-1");
    }
    expect(s.puts()).toBe(0);
    expect(s.proposals()).toBe(0);
  });
});

describe("propose_transactions", () => {
  it.each(["strict", "amounts"] as const)(
    "stores a pending import of the rows and commits through the owner's approval (%s)",
    async (privacy) => {
      const s = setup();
      s.f.run(setProfileSettings, { mcpPrivacy: privacy });
      const result = await s.server.call("propose_transactions", {
        account: s.ref,
        rows: ROWS,
        reason: "Synthetic typed-in trades",
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        stored: true,
        rows: 2n,
        preview: { new: 2n, duplicates: 0n, can_commit: true },
      });
      for (const value of VALUES) expect(serialized(result.data)).not.toContain(value);
      expect(transactions(s.f.store.read.bind(s.f.store))).toHaveLength(0);
      const snapshot = await s.approve((result.data as { proposal_id: string }).proposal_id);
      expect(snapshot.payload).toMatchObject({ account: s.account, blob: { ext: "json" } });
      expect(snapshot.payload.summary_params).toMatchObject({ new: 2, duplicates: 0 });
      const booked = transactions(s.f.store.read.bind(s.f.store));
      expect(booked).toHaveLength(2);
      expect(booked.every((t) => t.externalRef === null || t.externalRef === undefined)).toBe(
        true,
      );
      expect(s.puts()).toBe(1);
    },
  );
  it("stores nothing new when the same rows are proposed again after the commit", async () => {
    const s = setup();
    const first = await s.server.call("propose_transactions", { account: s.ref, rows: ROWS });
    await s.approve((first.data as { proposal_id: string }).proposal_id);
    const again = await s.server.call("propose_transactions", { account: s.ref, rows: ROWS });
    expect(again.ok).toBe(true);
    expect(again.data).toMatchObject({ stored: false, preview: { new: 0n, duplicates: 2n } });
    // Reordered or partly new rows: only the new one counts.
    const extra = { ...ROWS[0], date: "2026-11-20" };
    const mixed = await s.server.call("validate_transactions", {
      rows: [ROWS[1], extra, ROWS[0]],
      account: s.ref,
    });
    expect(mixed.data).toMatchObject({ preview: { new: 1n, duplicates: 2n } });
    expect(s.puts()).toBe(1);
    expect(s.proposals()).toBe(1);
    expect(transactions(s.f.store.read.bind(s.f.store))).toHaveLength(2);
  });
  it("points at the pending proposal instead of storing the same rows twice", async () => {
    const s = setup();
    const first = await s.server.call("propose_transactions", { account: s.ref, rows: ROWS });
    const again = await s.server.call("propose_transactions", { account: s.ref, rows: ROWS });
    expect(again.data).toMatchObject({
      stored: false,
      proposal_id: (first.data as { proposal_id: string }).proposal_id,
    });
    expect(s.puts()).toBe(1);
    expect(s.proposals()).toBe(1);
  });
  it("returns the blocking preview without publishing or proposing", async () => {
    const s = setup();
    const result = await s.server.call("propose_transactions", {
      account: s.ref,
      rows: [{ date: "2026-11-12", type: "buy", isin: "IE00B4L5Y983", currency: "EUR" }],
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ stored: false, preview: { can_commit: false } });
    expect(s.puts()).toBe(0);
    expect(s.proposals()).toBe(0);
  });
  it("refuses an unknown account and a bad source before publishing", async () => {
    const s = setup();
    const forged = await s.server.call("propose_transactions", {
      account: "account:forged",
      rows: ROWS,
    });
    expect(forged.ok).toBe(false);
    const source = await s.server.call("propose_transactions", {
      account: s.ref,
      rows: ROWS,
      source: "Not A Source",
    });
    expect(source.errorKind).toBe("invalid_arguments");
    expect(s.puts()).toBe(0);
  });
});
