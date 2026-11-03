import { describe, expect, it } from "vitest";
import { type CommandContext, ok, refuse } from "../command.js";
import type { Store } from "../materialize.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import {
  approvePrepared,
  createProposal,
  failApprovedProposal,
  rejectProposal,
} from "./proposal-commands.js";
import {
  type ExecutionSnapshot,
  type PreparedEffect,
  proposalExecution,
} from "./proposal-execution.js";

const read = (store: Store) => store.read.bind(store);
const payload = {
  kind: "strategy" as const,
  summary: "Invented strategy change",
  reason: null,
  payload: { base_sha256: "synthetic" },
  source: "synthetic",
};

function proposal(store: Store, env: ReturnType<typeof testEnv>): string {
  const out = run(store, env, createProposal, payload);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error("synthetic proposal refused");
  return out.value.proposalGid;
}

function childEffect(proposalGid: string): PreparedEffect<{ childGid: string }> {
  return {
    kind: "strategy",
    proposalGid,
    recheck: (_ctx, snapshot) =>
      snapshot.payload.base_sha256 === "synthetic" ? null : "base_changed",
    apply(ctx: CommandContext, _snapshot: ExecutionSnapshot) {
      const childGid = ctx.newGid();
      ctx.emit("proposal.created", childGid, {
        kind: "custom_rule",
        summary: "Invented caused proposal",
        reason: null,
        payload: {},
        source: "synthetic",
      });
      return ok({ childGid });
    },
    approvalResult: (effect) => ({ child: effect.childGid }),
  };
}

describe("proposal approval commands", () => {
  it("allows proposal creation away from the leader but keeps import approval on the leader", () => {
    const store = openTestStore();
    const follower = testEnv({ holder: false });
    const created = run(store, follower, createProposal, { ...payload, kind: "import" as const });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      run(
        store,
        follower,
        approvePrepared({ ...childEffect(created.value.proposalGid), kind: "import" }),
        {},
      ),
    ).toEqual({
      ok: false,
      reason: "not_holder",
    });
    expect(proposalExecution(read(store), created.value.proposalGid)?.status).toBe("pending");
  });

  it("allows a strategy decision on the owner device without an import lease", () => {
    const store = openTestStore();
    const follower = testEnv({ holder: false });
    const gid = proposal(store, follower);
    const approved = run(store, follower, approvePrepared(childEffect(gid)), {});
    expect(approved.ok).toBe(true);
    expect(proposalExecution(read(store), gid)?.status).toBe("approved");
  });

  it("reads the folded winner and revokes exactly its caused events on publish failure", () => {
    const store = openTestStore();
    const env = testEnv();
    const gid = proposal(store, env);
    expect(proposalExecution(read(store), gid)).toMatchObject({
      status: "pending",
      approvalEid: null,
      kind: "strategy",
    });
    const out = run(store, env, approvePrepared(childEffect(gid)), {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.events.map((event) => event.type)).toEqual([
      "proposal.approved",
      "proposal.created",
    ]);
    expect(out.events[1]?.cause).toBe(out.value.approvalEid);
    expect(out.events[0]?.data).toEqual({ result: { child: out.value.effect.childGid } });
    expect(proposalExecution(read(store), gid)?.approvalEid).toBe(out.value.approvalEid);
    expect(proposalExecution(read(store), out.value.effect.childGid)?.status).toBe("pending");
    expect(
      run(store, env, failApprovedProposal, {
        proposalGid: gid,
        approvalEid: "wrong-approval",
        result: { error_code: "write_failed" },
      }),
    ).toEqual({ ok: false, reason: "not_winning_approval" });
    const failed = run(store, env, failApprovedProposal, {
      proposalGid: gid,
      approvalEid: out.value.approvalEid,
      result: { error_code: "write_failed" },
    });
    expect(failed.ok).toBe(true);
    expect(proposalExecution(read(store), gid)?.status).toBe("failed");
    expect(proposalExecution(read(store), out.value.effect.childGid)).toBeUndefined();
  });

  it("discards approval and caused events when an effect refuses after emitting", () => {
    const store = openTestStore();
    const env = testEnv();
    const gid = proposal(store, env);
    let childGid = "";
    const effect: PreparedEffect<never> = {
      kind: "strategy",
      proposalGid: gid,
      recheck: () => null,
      apply(ctx) {
        childGid = ctx.newGid();
        ctx.emit("proposal.created", childGid, {
          kind: "custom_rule",
          summary: "Invented refused child",
          reason: null,
          payload: {},
          source: "synthetic",
        });
        return refuse("effect_refused");
      },
      approvalResult: () => ({}),
    };
    expect(run(store, env, approvePrepared(effect), {})).toEqual({
      ok: false,
      reason: "effect_refused",
    });
    expect(proposalExecution(read(store), gid)?.status).toBe("pending");
    expect(proposalExecution(read(store), childGid)).toBeUndefined();
  });

  it.each(["emit", "emitDeferred"] as const)(
    "rejects a conflicting child cause in %s without an append",
    (method) => {
      const store = openTestStore();
      const env = testEnv();
      const gid = proposal(store, env);
      const before = store.read<{ n: number }>("SELECT COUNT(*) AS n FROM proposals")[0]?.n;
      const effect: PreparedEffect<null> = {
        kind: "strategy",
        proposalGid: gid,
        recheck: () => null,
        apply(ctx) {
          const childGid = ctx.newGid();
          const data = {
            kind: "custom_rule",
            summary: "Invented conflicting child",
            reason: null,
            payload: {},
            source: "synthetic",
          };
          if (method === "emit")
            ctx.emit("proposal.created", childGid, data, { cause: "other-cause" });
          else
            ctx.emitDeferred("proposal.created", childGid, () => data, {
              cause: "other-cause",
            });
          return ok(null);
        },
        approvalResult: () => ({}),
      };
      expect(() => run(store, env, approvePrepared(effect), {})).toThrow("conflicting cause");
      expect(store.read<{ n: number }>("SELECT COUNT(*) AS n FROM proposals")[0]?.n).toBe(before);
      expect(proposalExecution(read(store), gid)?.status).toBe("pending");
    },
  );

  it("rejects a pending proposal and refuses a later approval without changing another vault", () => {
    const store = openTestStore();
    const other = openTestStore();
    const env = testEnv();
    const gid = proposal(store, env);
    expect(proposalExecution(read(other), gid)).toBeUndefined();
    const rejected = run(store, env, rejectProposal, { proposalGid: gid, note: null });
    expect(rejected.ok).toBe(true);
    expect(proposalExecution(read(store), gid)?.status).toBe("rejected");
    expect(run(store, env, approvePrepared(childEffect(gid)), {})).toEqual({
      ok: false,
      reason: "not_pending",
    });
  });
});
