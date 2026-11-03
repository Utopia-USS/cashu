import { D } from "@cashu/domain";
import { investmentsCommands as C, setModules, setProfileSettings } from "@cashu/store";
import { afterEach, describe, expect, it } from "vitest";
import * as L from "../privacy/labels.js";
import { type ToolArgs, ToolError, toolSpec } from "../registry.js";
import { asyncFixture, deferred } from "../testing/async.js";
import { type NativeAsyncAdapter, ownedValue } from "./async.js";
import { NativeMcpServer } from "./server.js";
import type { NativeToolStore } from "./types.js";

const opened: ReturnType<typeof asyncFixture>[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.f.close();
});
function fixture(
  options: {
    two?: boolean;
    cache?: boolean;
    badWarning?: boolean;
    sensitiveFailure?: boolean;
  } = {},
) {
  const s = asyncFixture();
  opened.push(s);
  const entered = [deferred<void>(), deferred<void>()];
  const answers = [
    deferred<ReturnType<typeof ownedValue>>(),
    deferred<ReturnType<typeof ownedValue>>(),
  ];
  let current = true,
    attempts = 0;
  const io = Object.freeze({
    vault: s.f.vault,
    binding: Object.freeze({}),
    isCurrent: () => current,
  });
  const adapter: NativeAsyncAdapter = {
    name: "propose_import",
    maxIoPhases: options.two ? 2 : 1,
    current: (_ctx, old) => current && io.binding === old.binding,
    advance(ctx, _args, resume) {
      expect(() =>
        (ctx.store as NativeToolStore).run(C.markReviewDone, { module: "investments" }),
      ).toThrow("preparation cannot write");
      if (resume === undefined || (options.two && resume === 1))
        return { kind: "io", io, operation: resume === undefined ? 0 : 1 };
      if (options.sensitiveFailure)
        throw new ToolError("Sensitive Synthetic Owner and private path");
      return { kind: "ready", ready: resume };
    },
    async perform(operation) {
      const index = Number(operation);
      entered[index]?.resolve();
      return await (answers[index]?.promise ?? Promise.reject(new Error("invalid test phase")));
    },
    async finish(ctx, args) {
      const result = await ctx.store.run(C.markReviewDone, { module: "investments" });
      if (!result.ok) throw new Error(result.reason);
      const answer = {
        saved: L.flag(true),
        total: L.amount(D("123")),
        message: L.text(String((args.nested as ToolArgs).message)),
      };
      return {
        answer,
        ...(options.cache
          ? {
              cacheFailureAnswer: options.badWarning
                ? ({ unsafe: "not labelled" } as unknown as L.LabelledTree)
                : { ...answer, warning: L.fixedText("saved; price cache is unavailable") },
              afterCommit: { data: null, io },
            }
          : {}),
      };
    },
    afterCommit() {
      attempts++;
      throw new Error("synthetic private cache failure");
    },
  };
  const spec = toolSpec<NativeToolStore>({
    name: "propose_import",
    module: "investments",
    description: "Synthetic buffered async write",
    write: true,
    properties: { nested: { type: "object" } },
    required: ["nested"],
    handler: () => {
      throw new Error("sync handler must not run");
    },
  });
  const ping = toolSpec<NativeToolStore>({
    name: "ping",
    module: "core",
    description: "Synthetic concurrent core read",
    handler: () => ({ ready: L.flag(true) }),
  });
  const server = new NativeMcpServer(s.runtime, [spec, ping], [adapter]);
  const call = (message = "safe") => server.call("propose_import", { nested: { message } });
  return {
    ...s,
    server,
    adapter,
    io,
    call,
    entered,
    answers,
    inactive: () => {
      current = false;
    },
    attempts: () => attempts,
  };
}
describe("bounded native async phases", () => {
  it.each(["privacy", "names", "closed", "replaced", "modules", "guard"])(
    "withholds completed data after audit barrier %s without repeating the append",
    async (change) => {
      const s = fixture();
      s.f.run(setProfileSettings, { mcpPrivacy: "amounts" });
      const entered = deferred<void>(),
        release = deferred<void>();
      const finish = s.runtime.audit.finish.bind(s.runtime.audit);
      s.runtime.audit.finish = async (...args) => {
        entered.resolve();
        await release.promise;
        await finish(...args);
      };
      const pending = s.call("Changed Owner");
      await s.entered[0]?.promise;
      s.answers[0]?.resolve(2);
      await entered.promise;
      expect(s.commits()).toBe(1);
      // A real serialized vault read completes while the separate audit finish is held.
      expect(
        await s.runtime.execute(undefined, (execution) =>
          execution?.context.store.read("SELECT COUNT(*) AS n FROM reviews"),
        ),
      ).toEqual([{ n: 1 }]);
      if (change === "privacy") s.f.run(setProfileSettings, { mcpPrivacy: "strict" });
      else if (change === "names")
        expect(
          s.f.run(C.addToWatchlist, {
            target: {
              planned: {
                symbol: "OWN",
                name: "Changed Owner",
                currency: "PLN",
                assetClass: "other",
              },
            },
          }).ok,
        ).toBe(true);
      else if (change === "closed") s.server.invalidateAsync();
      else if (change === "replaced") s.replace();
      else if (change === "modules") s.f.run(setModules, { moduleIds: ["budget"] });
      else s.failGuard();
      release.resolve();
      const result = await pending;
      expect(result).toEqual({
        ok: true,
        privacy: "strict",
        data: { completed: true, note: "completed; response withheld" },
      });
      expect(s.commits()).toBe(1);
      expect(s.f.store.read("SELECT COUNT(*) AS n FROM reviews")).toEqual([{ n: 1 }]);
      expect(s.audit).toEqual(["start", "finish:amounts:ok"]);
    },
  );
  it.each(["operation", "ready"])("owns %s before preparation resolves", async (kind) => {
    const s = fixture(),
      shared = { payload: "before" };
    const preparation = s.runtime.preparations;
    if (!preparation) throw new Error("missing synthetic preparation");
    Object.defineProperty(s.runtime, "preparations", {
      value: {
        execute: ((ceiling, fn) =>
          preparation.execute(ceiling, (execution) => {
            const next = fn(execution);
            shared.payload = "after";
            return next;
          })) satisfies typeof preparation.execute,
      },
    });
    const originalFinish = s.adapter.finish;
    s.adapter.advance = (_ctx, _args, resume) =>
      kind === "ready" || resume !== undefined
        ? { kind: "ready", ready: kind === "ready" ? shared : (resume ?? null) }
        : { kind: "io", operation: shared, io: s.io };
    s.adapter.perform = async (operation) => {
      expect(operation).toEqual({ payload: "before" });
      return 2;
    };
    s.adapter.finish = (ctx, args, ready) => {
      if (kind === "ready") expect(ready).toEqual({ payload: "before" });
      return originalFinish(ctx, args, ready);
    };
    expect((await s.call()).ok).toBe(true);
    expect(s.commits()).toBe(1);
  });
  it("releases the serialized queue during I/O, owns nested arguments and audits once", async () => {
    const s = fixture();
    const args = { nested: { message: "before" } };
    const pending = s.server.call("propose_import", args);
    args.nested.message = "after";
    await s.entered[0]?.promise;
    expect((await s.server.call("ping")).data).toEqual({ ready: true });
    s.answers[0]?.resolve(2);
    expect((await pending).data).toMatchObject({ saved: true, message: "before" });
    expect(s.f.store.read("SELECT COUNT(*) AS n FROM reviews")).toEqual([{ n: 1 }]);
    expect(s.commits()).toBe(2); // one read commit plus one actual write, no preparation commits
    expect(s.audit.filter((a) => a === "start")).toHaveLength(2);
    expect(s.audit.filter((a) => a.startsWith("finish:"))).toHaveLength(2);
  });
  it("keeps the strongest observed privacy across two stages and later relaxation", async () => {
    const s = fixture({ two: true });
    s.f.run(setProfileSettings, { mcpPrivacy: "amounts" });
    const pending = s.call();
    await s.entered[0]?.promise;
    s.f.run(setProfileSettings, { mcpPrivacy: "strict" });
    s.answers[0]?.resolve(1);
    await s.entered[1]?.promise;
    s.f.run(setProfileSettings, { mcpPrivacy: "amounts" });
    s.answers[1]?.resolve(2);
    const result = await pending;
    expect(result.privacy).toBe("strict");
    expect(result.data).not.toHaveProperty("total");
    expect(s.audit).toEqual(["start", "finish:strict:ok"]);
    expect(s.commits()).toBe(1);
  });
  it.each(["closed", "replaced", "disabled", "capability"])(
    "refuses %s after I/O without appending",
    async (change) => {
      const s = fixture();
      const pending = s.call();
      await s.entered[0]?.promise;
      if (change === "closed") s.server.invalidateAsync();
      else if (change === "replaced") s.replace();
      else if (change === "disabled") s.f.run(setModules, { moduleIds: ["budget"] });
      else s.inactive();
      s.answers[0]?.resolve(2);
      expect((await pending).ok).toBe(false);
      expect(s.commits()).toBe(0);
      expect(s.f.store.read("SELECT COUNT(*) AS n FROM reviews")).toEqual([{ n: 0 }]);
      expect(s.audit.filter((a) => a.startsWith("finish:"))).toHaveLength(1);
    },
  );
  it("freshly guards I/O errors and gives current module guards precedence", async () => {
    const s = fixture();
    const pending = s.call();
    await s.entered[0]?.promise;
    s.f.run(setModules, { moduleIds: ["budget"] });
    s.answers[0]?.reject(new Error("synthetic private path and owner details"));
    const result = await pending;
    expect(result.errorKind).toBe("module_disabled");
    expect(result.error).not.toContain("private");
    expect(s.commits()).toBe(0);
  });
  it("uses fresh private-name sources at final redaction", async () => {
    const s = fixture();
    const pending = s.call("Changed Owner");
    await s.entered[0]?.promise;
    expect(
      s.f.run(C.addToWatchlist, {
        target: {
          planned: { symbol: "OWN", name: "Changed Owner", currency: "PLN", assetClass: "other" },
        },
      }).ok,
    ).toBe(true);
    s.answers[0]?.resolve(2);
    const result = await pending;
    expect(JSON.stringify(result)).not.toContain("Changed Owner");
  });
  it("returns saved success after synchronous cache failure, never retries the write", async () => {
    const s = fixture({ cache: true });
    const pending = s.call();
    await s.entered[0]?.promise;
    s.answers[0]?.resolve(2);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      saved: true,
      warning: "saved; price cache is unavailable",
    });
    expect(s.attempts()).toBe(1);
    expect(s.commits()).toBe(1);
    expect(s.warnings).toEqual(["mcp.async-cache-failed"]);
  });
  it("validates the warning variant before commit or cache publication", async () => {
    const s = fixture({ cache: true, badWarning: true });
    const pending = s.call();
    await s.entered[0]?.promise;
    s.answers[0]?.resolve(2);
    expect((await pending).errorKind).toBe("unlabelled");
    expect(s.commits()).toBe(0);
    expect(s.attempts()).toBe(0);
    expect(s.f.store.read("SELECT COUNT(*) AS n FROM reviews")).toEqual([{ n: 0 }]);
  });
  it("withholds source error text with strict privacy when the fresh guard cannot load", async () => {
    const s = fixture({ sensitiveFailure: true });
    s.f.run(setProfileSettings, { mcpPrivacy: "amounts" });
    const pending = s.call();
    await s.entered[0]?.promise;
    s.failGuard();
    s.answers[0]?.resolve(2);
    const result = await pending;
    expect(result.errorKind).toBe("privacy_check");
    expect(result.privacy).toBe("strict");
    expect(result.error).not.toContain("Sensitive");
    expect(result.error).not.toContain("private path");
    expect(s.commits()).toBe(0);
  });
  it("privately copies bytes and plain containers and rejects unowned values", () => {
    const bytes = Uint8Array.of(1, 2);
    const copied = ownedValue({ bytes, list: ["before"] }) as { bytes: Uint8Array; list: string[] };
    bytes[0] = 9;
    expect(copied.bytes[0]).toBe(1);
    expect(Object.isFrozen(copied.list)).toBe(true);
    let indexedReads = 0,
      mapCalls = 0;
    const accessor = [1];
    Object.defineProperty(accessor, "0", {
      get() {
        indexedReads++;
        return 1;
      },
    });
    expect(() => ownedValue(accessor)).toThrow("accessor");
    expect(indexedReads).toBe(0);
    const overridden = [1];
    Object.defineProperty(overridden, "map", {
      value() {
        mapCalls++;
        return [];
      },
    });
    expect(() => ownedValue(overridden)).toThrow("shape");
    expect(mapCalls).toBe(0);
    expect(() => ownedValue(new Date())).toThrow();
    expect(() =>
      ownedValue({
        get value() {
          throw new Error("accessor called");
        },
      }),
    ).toThrow("accessor");
  });
});
