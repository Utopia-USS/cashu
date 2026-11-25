import { describe, expect, it } from "vitest";
import { ok, runCommand, storeWriter } from "../command.js";
import { testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { createProposal } from "./proposal-commands.js";
import type { PreparedEffect } from "./proposal-execution.js";
import { proposalExecution } from "./proposal-execution.js";
import {
  type ApprovalExecutionDeps,
  type ApprovalPublication,
  executePreparedApproval,
  ProposalApplyingLock,
} from "./proposal-service.js";

class TestLock {
  private held = false;
  tryAcquire(): (() => void) | null {
    if (this.held) return null;
    this.held = true;
    return () => {
      this.held = false;
    };
  }
}

function fixture() {
  const store = openTestStore();
  const env = testEnv();
  const writer = storeWriter(store);
  const created = runCommand(
    store,
    writer,
    createProposal,
    {
      kind: "strategy",
      summary: "Invented proposal",
      reason: null,
      payload: {},
      source: "synthetic",
    },
    env,
  );
  if (!created.ok) throw new Error("synthetic proposal refused");
  const applyingLock = new ProposalApplyingLock();
  const dailyLock = new TestLock();
  const holder = true;
  let vaultCurrent = true;
  let inWrite = false;
  let emittedChild: string | null = null;
  const deps: ApprovalExecutionDeps = {
    store,
    writer,
    env,
    applyingLock,
    dailyLock,
    isHolder: () => holder,
    isVaultCurrent: () => vaultCurrent,
    runWrite: async (work) => {
      inWrite = true;
      try {
        return work();
      } finally {
        inWrite = false;
      }
    },
  };
  const effect: PreparedEffect<{ childGid: string }> = {
    proposalGid: created.value.proposalGid,
    kind: "strategy",
    recheck: () => null,
    apply(ctx) {
      const childGid = ctx.newGid();
      emittedChild = childGid;
      ctx.emit("proposal.created", childGid, {
        kind: "custom_rule",
        summary: "Invented caused child",
        reason: null,
        payload: {},
        source: "synthetic",
      });
      return ok({ childGid });
    },
    approvalResult: (value) => ({ child: value.childGid }),
  };
  return {
    store,
    deps,
    effect,
    dailyLock,
    applyingLock,
    get inWrite() {
      return inWrite;
    },
    get emittedChild() {
      return emittedChild;
    },
    loseAuthority: () => {
      vaultCurrent = false;
    },
  };
}

describe("prepared proposal publication lifecycle", () => {
  it("rechecks import holder authority inside the durable decision callback", async () => {
    const f = fixture();
    let appended = 0;
    let published = 0;
    const result = await executePreparedApproval(
      {
        ...f.deps,
        isHolder: () => false,
        runDurable: async (_command, _input, current) => {
          if (!current()) return { kind: "refused", reason: "authority_lost" };
          appended++;
          throw new Error("unexpected synthetic append");
        },
      },
      { ...f.effect, kind: "import" },
      {
        publish: async () => {
          published++;
        },
        restore: async () => {},
        discard: async () => {},
      },
    );
    expect(result).toMatchObject({ status: "refused", reason: "authority_lost" });
    expect(appended).toBe(0);
    expect(published).toBe(0);
  });

  it("retains publication evidence when the durable approval result is unknown", async () => {
    const f = fixture();
    let published = false;
    let discarded = false;
    const outcome = await executePreparedApproval(
      {
        ...f.deps,
        runDurable: async () => ({ kind: "outcome_unknown", key: "synthetic-key" }),
      },
      f.effect,
      {
        publish: async () => {
          published = true;
        },
        restore: async () => {},
        discard: async () => {
          discarded = true;
        },
      },
    );
    expect(outcome).toEqual({
      status: "outcome_unknown",
      key: "synthetic-key",
      command: "core.approvePrepared",
    });
    expect(published).toBe(false);
    expect(discarded).toBe(false);
  });
  it("holds both locks through publication and reconciliation outside the short write step", async () => {
    const f = fixture();
    const phases: string[] = [];
    const publication: ApprovalPublication<{ childGid: string }> = {
      async publish(approvalEid) {
        phases.push("publish");
        expect(f.inWrite).toBe(false);
        expect(f.dailyLock.tryAcquire()).toBeNull();
        expect(f.applyingLock.tryAcquire(f.store.vault)).toBeNull();
        expect(
          proposalExecution(f.store.read.bind(f.store), f.effect.proposalGid)?.approvalEid,
        ).toBe(approvalEid);
      },
      async restore() {
        phases.push("restore");
      },
      async discard() {
        phases.push("discard");
      },
      async reconcile() {
        phases.push("reconcile");
        expect(f.inWrite).toBe(false);
        expect(f.dailyLock.tryAcquire()).toBeNull();
      },
    };
    const result = await executePreparedApproval(f.deps, f.effect, publication);
    expect(result.status).toBe("approved");
    expect(phases).toEqual(["publish", "reconcile"]);
    const releaseDaily = f.dailyLock.tryAcquire();
    expect(releaseDaily).not.toBeNull();
    releaseDaily?.();
    const releaseApplying = f.applyingLock.tryAcquire(f.store.vault);
    expect(releaseApplying).not.toBeNull();
    releaseApplying?.();
  });

  it("restores files, records guarded applyFailed and revokes caused effects on publish failure", async () => {
    const f = fixture();
    const phases: string[] = [];
    const result = await executePreparedApproval(f.deps, f.effect, {
      async publish() {
        phases.push("publish");
        throw new Error("synthetic file failure");
      },
      async restore() {
        phases.push("restore");
      },
      async discard() {
        phases.push("discard");
      },
      async reconcile() {
        phases.push("reconcile");
      },
    });
    expect(result.status).toBe("failed");
    expect(phases).toEqual(["publish", "restore", "reconcile"]);
    expect(proposalExecution(f.store.read.bind(f.store), f.effect.proposalGid)?.status).toBe(
      "failed",
    );
    expect(f.emittedChild).not.toBeNull();
    expect(proposalExecution(f.store.read.bind(f.store), f.emittedChild ?? "")).toBeUndefined();
  });

  it("leaves a value-free recovery receipt if authority is lost after record", async () => {
    const f = fixture();
    let restored = false;
    let reconciled = false;
    const result = await executePreparedApproval(f.deps, f.effect, {
      async publish() {
        f.loseAuthority();
        throw new Error("synthetic authority loss");
      },
      async restore() {
        restored = true;
      },
      async discard() {},
      async reconcile() {
        reconciled = true;
      },
    });
    expect(result).toMatchObject({ status: "recovery_needed", reason: "authority_lost" });
    expect(restored).toBe(false);
    expect(reconciled).toBe(false);
    expect(proposalExecution(f.store.read.bind(f.store), f.effect.proposalGid)?.status).toBe(
      "approved",
    );
  });

  it("discards private staging when the shared daily lock is busy", async () => {
    const f = fixture();
    const release = f.dailyLock.tryAcquire();
    let discarded = false;
    try {
      const result = await executePreparedApproval(f.deps, f.effect, {
        async publish() {
          throw new Error("must not publish");
        },
        async restore() {},
        async discard() {
          discarded = true;
        },
      });
      expect(result).toMatchObject({ status: "refused", reason: "busy" });
      expect(discarded).toBe(true);
      expect(proposalExecution(f.store.read.bind(f.store), f.effect.proposalGid)?.status).toBe(
        "pending",
      );
    } finally {
      release?.();
    }
  });

  it.each(["acquire", "release"] as const)(
    "releases the per-vault lock when the injected daily lock throws during %s",
    async (phase) => {
      const f = fixture();
      const deps: ApprovalExecutionDeps = {
        ...f.deps,
        dailyLock: {
          tryAcquire() {
            if (phase === "acquire") throw new Error("synthetic daily acquire failure");
            return () => {
              throw new Error("synthetic daily release failure");
            };
          },
        },
      };
      await expect(executePreparedApproval(deps, f.effect)).rejects.toThrow(
        `synthetic daily ${phase} failure`,
      );
      const release = f.applyingLock.tryAcquire(f.store.vault);
      expect(release).not.toBeNull();
      release?.();
    },
  );
});
