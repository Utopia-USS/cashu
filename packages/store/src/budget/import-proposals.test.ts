import { describe, expect, it } from "vitest";
import { openAccount } from "../core/commands.js";
import type { ExecutionSnapshot } from "../core/proposal-execution.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore, testUlid } from "../testing/store.js";
import { prepareBudgetImport } from "./import-proposals.js";

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
