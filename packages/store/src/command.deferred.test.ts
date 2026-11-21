import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type CommandContext,
  defineCommand,
  InvalidEmitError,
  ok,
  refuse,
  runCommand,
  storeWriter,
} from "./command.js";
import { testEnv } from "./testing/commands.js";
import { openTestStore } from "./testing/store.js";

const proposalData = {
  kind: "strategy",
  summary: "Invented proposal",
  reason: null,
  payload: {},
  source: "synthetic",
};

describe("deferred command event data", () => {
  it("resolves a real effect result after reserving approval order and cause", () => {
    const store = openTestStore();
    const cmd = defineCommand({
      id: "test.deferredApproval",
      input: z.object({}),
      run(ctx: CommandContext) {
        const gid = ctx.newGid();
        ctx.emit("proposal.created", gid, proposalData);
        let causedGid = "";
        let resolutions = 0;
        const approval = ctx.emitDeferred("proposal.approved", gid, () => {
          resolutions += 1;
          return { result: { caused: causedGid } };
        });
        causedGid = ctx.newGid();
        ctx.emit("proposal.created", causedGid, proposalData, { cause: approval });
        return ok({ approval, causedGid, resolutions: () => resolutions });
      },
    });
    const out = runCommand(store, storeWriter(store), cmd, {}, testEnv());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.resolutions()).toBe(1);
    expect(out.events.map((event) => event.type)).toEqual([
      "proposal.created",
      "proposal.approved",
      "proposal.created",
    ]);
    expect(out.events[1]?.eid).toBe(out.value.approval);
    expect(out.events[1]?.data).toEqual({ result: { caused: out.value.causedGid } });
    expect(out.events[2]?.cause).toBe(out.value.approval);
  });

  it("does not resolve or append a refused command", () => {
    const store = openTestStore();
    let resolutions = 0;
    let appends = 0;
    const cmd = defineCommand({
      id: "test.deferredRefusal",
      input: z.object({}),
      run(ctx: CommandContext) {
        ctx.emitDeferred("proposal.approved", ctx.newGid(), () => {
          resolutions += 1;
          return { result: {} };
        });
        return refuse("synthetic_refusal");
      },
    });
    expect(runCommand(store, { append: () => (appends += 1) }, cmd, {}, testEnv())).toEqual({
      ok: false,
      reason: "synthetic_refusal",
    });
    expect(resolutions).toBe(0);
    expect(appends).toBe(0);
  });

  it("appends nothing on a throwing, invalid or async resolver", () => {
    for (const resolveData of [
      () => {
        throw new Error("synthetic resolver failure");
      },
      () => ({ result: "not an object" }),
      (async () => ({ result: {} })) as unknown as () => Record<string, unknown>,
    ]) {
      const store = openTestStore();
      let appends = 0;
      const cmd = defineCommand({
        id: "test.deferredInvalid",
        input: z.object({}),
        run(ctx: CommandContext) {
          ctx.emitDeferred("proposal.approved", ctx.newGid(), resolveData);
          return ok({});
        },
      });
      expect(() =>
        runCommand(store, { append: () => (appends += 1) }, cmd, {}, testEnv()),
      ).toThrow();
      expect(appends).toBe(0);
    }
  });

  it("rejects reentrant emission even when a resolver catches its error", () => {
    const store = openTestStore();
    let appends = 0;
    const cmd = defineCommand({
      id: "test.deferredReentrant",
      input: z.object({}),
      run(ctx: CommandContext) {
        ctx.emitDeferred("proposal.approved", ctx.newGid(), () => {
          try {
            ctx.emit("proposal.created", ctx.newGid(), proposalData);
          } catch (error) {
            expect(error).toBeInstanceOf(InvalidEmitError);
          }
          return { result: {} };
        });
        return ok({});
      },
    });
    expect(() => runCommand(store, { append: () => (appends += 1) }, cmd, {}, testEnv())).toThrow(
      InvalidEmitError,
    );
    expect(appends).toBe(0);
  });
});
