import { commandFingerprint, ok, runCommand } from "@cashu/store";
import { createProposal, type PreparedEffect } from "@cashu/store/core";
import { StrategyProposalError } from "@cashu/store/investments/services";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import {
  bindApprovalIntent,
  type ProposalApprovalProvider,
  proposalScreen,
} from "./proposalsScreen.js";
import { cleanup, tempDir, testHostOptions } from "./testing/harness.js";

afterEach(cleanup);

it("binds an approval closure to proposal and prepared-object identity", () => {
  const command = {
    id: "core.approvePrepared",
    input: { parse: () => ({}) },
    run: () => ok("synthetic"),
  } as unknown as import("@cashu/store").Command<Record<string, never>, string>;
  const proposal = "0".repeat(26);
  const first = bindApprovalIntent(command, {}, proposal, "11111111-1111-4111-8111-111111111111");
  const second = bindApprovalIntent(command, {}, proposal, "22222222-2222-4222-8222-222222222222");
  const parsed = first.command.input.parse(first.input);
  expect(commandFingerprint("a".repeat(32), first.command.id, parsed)).not.toBe(
    commandFingerprint("a".repeat(32), second.command.id, second.command.input.parse(second.input)),
  );
  expect(first.command.run({} as never, { ...first.input, proposalGid: "1".repeat(26) })).toEqual({
    ok: false,
    reason: "wrong_preparation",
  });
});

it("retains the original unknown proposal attempt without re-dispatch", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("missing synthetic vault");
  const created = await vault.queue.run(() =>
    runCommand(
      vault.store,
      vault.writer,
      createProposal,
      {
        kind: "strategy",
        summary: "Synthetic",
        reason: null,
        payload: {},
        source: "synthetic",
      },
      vault.env,
    ),
  );
  if (!created.ok) throw new Error("synthetic proposal refused");
  const another = await vault.queue.run(() =>
    runCommand(
      vault.store,
      vault.writer,
      createProposal,
      {
        kind: "strategy",
        summary: "Another synthetic proposal",
        reason: null,
        payload: {},
        source: "synthetic",
      },
      vault.env,
    ),
  );
  if (!another.ok) throw new Error("second synthetic proposal refused");
  const action = proposalScreen();
  const originalAppend = vault.writer.append;
  let calls = 0;
  vault.writer.append = () => {
    calls++;
    throw new Error("synthetic ambiguous append");
  };
  try {
    const request = { gid: created.value.proposalGid, decision: "reject" };
    const first = await action.run(host.stores, vault.id, request);
    expect(first).toMatchObject({
      status: "outcome_unknown",
      attempt: { command: "core.rejectProposal" },
    });
    expect(await action.run(host.stores, vault.id, request)).toEqual(first);
    expect(
      await action.run(host.stores, vault.id, {
        gid: another.value.proposalGid,
        decision: "reject",
      }),
    ).toEqual({ status: "not_started", reason: "pending_previous_attempt" });
    expect(calls).toBe(1);
  } finally {
    vault.writer.append = originalAppend;
    await host.stop();
  }
});

it("returns real S60 approved, refused cleanup, failed and recovery receipts for canonical proposals", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("missing synthetic vault");
  let mode: "approve" | "refuse" | "fail" | "recovery" = "approve";
  let current = true;
  let held = false;
  const lock = {
    tryAcquire: () =>
      held
        ? null
        : () => {
            held = false;
          },
  };
  const provider: ProposalApprovalProvider = {
    bind: (id) =>
      id === vault.id
        ? {
            generation: "synthetic-current",
            dailyLock: lock,
            isCurrent: () => current,
            isHolder: () => true,
            async prepare(snapshot) {
              const effect: PreparedEffect<{ version: number }> = {
                proposalGid: snapshot.gid,
                kind: snapshot.kind,
                recheck: () => (mode === "refuse" ? "base_changed" : null),
                apply: () => ok({ version: 7 }),
                approvalResult: (result) => ({ version: result.version }),
              };
              return {
                effect,
                publication: {
                  publish: async () => {
                    if (mode === "fail" || mode === "recovery")
                      throw new Error("synthetic publication failure");
                  },
                  restore: async () => {
                    if (mode === "recovery") throw new Error("synthetic restore failure");
                  },
                  discard: async () => {
                    if (mode === "refuse") throw new Error("synthetic discard failure");
                  },
                },
              };
            },
          }
        : null,
  };
  const action = proposalScreen(provider, provider);
  const make = async () => {
    const created = await vault.queue.run(() =>
      runCommand(
        vault.store,
        vault.writer,
        createProposal,
        {
          kind: "strategy",
          summary: "Synthetic proposal",
          reason: null,
          payload: { base_sha256: "synthetic" },
          source: "synthetic",
        },
        vault.env,
      ),
    );
    if (!created.ok) throw new Error(created.reason);
    return created.value.proposalGid;
  };
  const review = (gid: string, decision: "approve" | "reject" = "approve") =>
    action.run(host.stores, vault.id, { gid, decision });
  try {
    const approvedGid = await make();
    expect(await review(approvedGid)).toMatchObject({
      status: "completed",
      value: { status: "approved", effect: { version: 7 } },
    });
    expect(
      vault.store.read<{ status: string }>(
        "SELECT status FROM proposals WHERE gid = ?",
        approvedGid,
      )[0]?.status,
    ).toBe("approved");
    expect(await review(approvedGid)).toMatchObject({ status: "refused", reason: "not_pending" });
    mode = "refuse";
    const refusedGid = await make();
    expect(await review(refusedGid)).toMatchObject({
      status: "completed",
      value: { status: "refused", reason: "base_changed", cleanupFailed: true },
    });
    mode = "fail";
    const failedGid = await make();
    expect(await review(failedGid)).toMatchObject({
      status: "completed",
      value: { status: "failed", reason: "write_failed" },
    });
    expect(
      vault.store.read<{ status: string }>(
        "SELECT status FROM proposals WHERE gid = ?",
        failedGid,
      )[0]?.status,
    ).toBe("failed");
    mode = "recovery";
    const recoveryGid = await make();
    expect(await review(recoveryGid)).toMatchObject({
      status: "completed",
      value: { status: "recovery_needed", reason: "restore_failed" },
    });
    current = false;
    expect(await review(await make())).toMatchObject({
      status: "refused",
      reason: "capability_unavailable",
    });
    current = true;
    const rejectedGid = await make();
    expect(await review(rejectedGid, "reject")).toMatchObject({
      status: "completed",
      value: { status: "rejected", proposalGid: rejectedGid },
    });
  } finally {
    await host.stop();
  }
});

it("surfaces the strategy refusal code of a failed preparation, not preparation_failed", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("missing synthetic vault");
  let thrown: Error = new Error("synthetic");
  const provider: ProposalApprovalProvider = {
    bind: (id) =>
      id === vault.id
        ? {
            generation: "synthetic-current",
            dailyLock: { tryAcquire: () => () => {} },
            isCurrent: () => true,
            isHolder: () => true,
            async prepare() {
              throw thrown;
            },
          }
        : null,
  };
  const action = proposalScreen(undefined, provider);
  const created = await vault.queue.run(() =>
    runCommand(
      vault.store,
      vault.writer,
      createProposal,
      {
        kind: "custom_rule",
        summary: "Synthetic rule proposal",
        reason: null,
        payload: { rule: { id: "synthetic" } },
        source: "synthetic",
      },
      vault.env,
    ),
  );
  if (!created.ok) throw new Error(created.reason);
  const approve = () =>
    action.run(host.stores, vault.id, { gid: created.value.proposalGid, decision: "approve" });
  for (const code of ["rule_exists", "base_changed", "strategy_missing", "rule_invalid"]) {
    thrown = new StrategyProposalError(code, "synthetic refusal");
    expect(await approve()).toEqual({ status: "refused", reason: code, preparation: "none" });
  }
  // Internal failures keep the generic reason.
  thrown = new StrategyProposalError("unavailable", "synthetic refusal");
  expect(await approve()).toMatchObject({ status: "refused", reason: "preparation_failed" });
  thrown = new Error("synthetic crash");
  expect(await approve()).toMatchObject({ status: "refused", reason: "preparation_failed" });
});
