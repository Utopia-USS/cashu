import { describe, expect, it } from "vitest";
import { openAccount } from "../core/commands.js";
import type { ExecutionSnapshot } from "../core/proposal-execution.js";
import { vault } from "../investments/commands/testing/fixtures.js";
import { testUlid } from "../testing/store.js";
import { prepareBudgetImport } from "./import-proposals.js";

function fixture() {
  const v = vault();
  const account = v.value(openAccount, {
    bank: "mbank",
    name: "Synthetic bank",
    type: "checking",
    currency: "PLN",
  }).account;
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
  return { v, snapshot };
}

describe("budget proposal binding boundary", () => {
  it("validates owned native metadata then refuses before any staged bytes or effects", () => {
    const { v, snapshot } = fixture();
    expect(prepareBudgetImport(v.store.read.bind(v.store), snapshot)).toEqual({
      ok: false,
      reason: "connector_binding_unsupported",
    });
    expect(v.store.read("SELECT gid FROM proposals")).toHaveLength(0);
    expect(v.store.read("SELECT gid FROM transactions")).toHaveLength(0);
  });
  it("does not convert legacy binding/run ids into a made-up approval capability", () => {
    const { v, snapshot } = fixture();
    expect(
      prepareBudgetImport(v.store.read.bind(v.store), {
        ...snapshot,
        payload: { ...snapshot.payload, binding_id: 1, run_id: 2 },
      }),
    ).toEqual({ ok: false, reason: "connector_binding_unsupported" });
  });
  it("refuses absent/foreign target, nonconnector input and inconsistent blob metadata", () => {
    const { v, snapshot } = fixture();
    const read = v.store.read.bind(v.store);
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
