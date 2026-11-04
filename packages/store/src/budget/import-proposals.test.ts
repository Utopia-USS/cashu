import { describe, expect, it } from "vitest";
import { openAccount } from "../core/commands.js";
import { approvePrepared, createProposal } from "../core/proposal-commands.js";
import type { ExecutionSnapshot } from "../core/proposal-execution.js";
import { proposalExecution } from "../core/proposal-execution.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore, testUlid } from "../testing/store.js";
import { prepareBudgetConnectorImport, prepareBudgetImport } from "./import-proposals.js";

function fixture() {
  const store = openTestStore();
  const opened = run(store, testEnv(), openAccount, {
    bank: "mbank",
    name: "Synthetic bank",
    type: "checking",
    currency: "PLN",
  });
  if (!opened.ok) throw new Error("synthetic account refused");
  const account = opened.value.account;
  const snapshot: ExecutionSnapshot = {
    gid: testUlid("01JG", 400),
    kind: "budget_import",
    status: "pending",
    summary: "Synthetic connector statement",
    reason: null,
    source: "connector",
    approvalEid: null,
    result: {},
    payload: {
      account,
      source: "connector",
      file_name: "converted.json",
      file_sha256: "a".repeat(64),
      blob: { sha256: "a".repeat(64), ext: "json" },
    },
  };
  return { store, snapshot };
}

describe("budget proposal binding boundary", () => {
  it("approves an exact-vault connector proposal with an empty import and caused cursor", () => {
    const { store, snapshot } = fixture();
    const env = testEnv({ seed: 2 });
    const account = snapshot.payload.account as string;
    const bindingId = testUlid("01JG", 402);
    const binding = {
      id: bindingId,
      profileId: store.vault,
      accountId: account,
      connectorId: "synthetic",
      module: "budget",
      baseCursor: null,
      paramsDigest: "a".repeat(64),
      approvedCodeDigest: "b".repeat(64),
      interpreter: "/synthetic/interpreter",
      newCursor: "page-2",
    };
    const created = run(store, env, createProposal, {
      kind: "budget_import",
      summary: "Synthetic connector import",
      reason: null,
      source: "connector",
      payload: { ...snapshot.payload, connector_binding: binding },
    });
    if (!created.ok) throw new Error("synthetic proposal refused");
    const current = proposalExecution(store.read.bind(store), created.value.proposalGid);
    if (!current) throw new Error("synthetic proposal absent");
    const prepared = prepareBudgetConnectorImport({
      read: store.read.bind(store),
      snapshot: current,
      vault: store.vault,
      statement: {
        bank: "mbank",
        accountNumber: null,
        accountNumberOrigin: null,
        accountName: null,
        currency: "PLN",
        transactions: [],
        balances: [],
        closingBalances: [],
        skippedRows: 0,
      },
      check: () => true,
    });
    if (!prepared.ok) throw new Error(`synthetic preparation refused: ${prepared.reason}`);
    const approved = run(store, env, approvePrepared(prepared.value), {});
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.events.map((event) => event.type)).toEqual([
      "proposal.approved",
      "importBatch.recorded",
      "connectorBinding.cursorAdvanced",
    ]);
    expect(approved.events.slice(1).every((event) => event.cause === approved.events[0]?.eid)).toBe(
      true,
    );
  });
  it("validates owned native metadata then refuses before any staged bytes or effects", () => {
    const { store, snapshot } = fixture();
    expect(prepareBudgetImport(store.read.bind(store), snapshot)).toEqual({
      ok: false,
      reason: "connector_binding_unsupported",
    });
    expect(store.read("SELECT gid FROM proposals")).toHaveLength(0);
    expect(store.read("SELECT gid FROM transactions")).toHaveLength(0);
  });
  it("does not convert legacy binding/run ids into a made-up approval capability", () => {
    const { store, snapshot } = fixture();
    expect(
      prepareBudgetImport(store.read.bind(store), {
        ...snapshot,
        payload: { ...snapshot.payload, binding_id: 1, run_id: 2 },
      }),
    ).toEqual({ ok: false, reason: "connector_binding_unsupported" });
  });
  it("refuses absent/foreign target, nonconnector input and inconsistent blob metadata", () => {
    const { store, snapshot } = fixture();
    const read = store.read.bind(store);
    expect(
      prepareBudgetImport(read, {
        ...snapshot,
        payload: { ...snapshot.payload, account: testUlid("01JG", 401) },
      }).reason,
    ).toBe("no_account");
    expect(
      prepareBudgetImport(read, { ...snapshot, payload: { ...snapshot.payload, source: "agent" } })
        .reason,
    ).toBe("invalid_payload");
    expect(
      prepareBudgetImport(read, {
        ...snapshot,
        payload: { ...snapshot.payload, file_sha256: "b".repeat(64) },
      }).reason,
    ).toBe("staged_changed");
  });
});
