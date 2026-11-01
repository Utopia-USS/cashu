import { D } from "@cashu/domain";
import {
  investmentsCommands,
  runCommand,
  setModules,
  setProfileSettings,
  storeWriter,
  type v1,
} from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import { afterEach, describe, expect, it } from "vitest";
import { amount, count, type LabelledTree } from "../privacy/labels.js";
import { toolContext, toolSpec } from "../registry.js";
import { nativeFixture } from "../testing/native.js";
import { NativeMcpServer, type NativeRuntime, restrictivePrivacy, resultText } from "./server.js";
import type { NativeToolStore } from "./types.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function setup() {
  const f = nativeFixture();
  fixtures.push(f);
  const audit: string[] = [];
  let unavailable = false;
  let replaced = false;
  const policy = () => {
    const p = mcpProfile(f.store.read.bind(f.store));
    return p
      ? {
          privacy: p.mcpPrivacy === "amounts" ? ("amounts" as const) : ("strict" as const),
          modules: new Set(p.modules),
        }
      : undefined;
  };
  const runtime: NativeRuntime = {
    now: f.env.clock.now,
    replaced: () => replaced,
    warn: (code) => audit.push(code),
    policy: async () => policy(),
    delegation: async () => {
      const current = policy();
      return current
        ? {
            ...current,
            names: { persons: [], strongNames: [], privatePayees: [], strictNames: [] },
          }
        : undefined;
    },
    audit: {
      start: async (tool, args) => {
        if (unavailable) throw new Error("unavailable");
        audit.push(`start:${tool}:${JSON.stringify(args)}`);
        return 1;
      },
      finish: async (_id, privacy, outcome) => {
        audit.push(`finish:${privacy}:${outcome}`);
      },
    },
    execute: async (ceiling, fn) => {
      const p = policy();
      if (!p) return fn(undefined);
      const pending: v1.Envelope[] = [];
      const base = f.context(restrictivePrivacy(p.privacy, ceiling));
      const store: NativeToolStore = {
        ...base.store,
        run: (command, input) =>
          runCommand(
            f.store,
            { append: (events) => pending.push(...events) },
            command,
            input,
            f.env,
          ),
      };
      const context = toolContext({
        store,
        profileId: base.profileId,
        privacy: restrictivePrivacy(p.privacy, ceiling),
        today: base.today,
        loadGuard: () => base.guard,
        loadAccountLabels: () => base.accountLabels,
      });
      return fn({
        context,
        policy: p,
        commit: () => {
          audit.push("commit");
          storeWriter(f.store).append(pending);
        },
      });
    },
  };
  return {
    f,
    runtime,
    audit,
    failAudit: () => {
      unavailable = true;
    },
    replace: () => {
      replaced = true;
    },
  };
}

describe("native MCP call boundary", () => {
  it("rereads policy/modules and applies a restrictive ceiling to the handler context", async () => {
    const s = setup();
    const spec = toolSpec<NativeToolStore>({
      name: "sample",
      description: "Synthetic read",
      module: "investments",
      handler: (ctx) => ({ total: amount(D("123")), strict: count(ctx.strict ? 1 : 0) }),
    });
    const server = new NativeMcpServer(s.runtime, [spec]);
    s.f.run(setProfileSettings, { mcpPrivacy: "amounts" });
    expect((await server.call("sample")).data).toEqual({ total: 123, strict: 0n });
    expect((await server.call("sample", {}, "strict")).data).toEqual({ strict: 1n });
    s.f.run(setProfileSettings, { mcpPrivacy: "strict" });
    expect((await server.call("sample", {}, "amounts")).data).toEqual({ strict: 1n });
    s.f.run(setModules, { moduleIds: ["budget"] });
    expect(await server.list()).toEqual([]);
    expect((await server.call("sample")).errorKind).toBe("module_disabled");
  });
  it("never appends a staged review when its answer fails privacy", async () => {
    const s = setup();
    const spec = toolSpec<NativeToolStore>({
      name: "write",
      description: "Synthetic write",
      module: "core",
      write: true,
      handler: (ctx) => {
        expect(
          ctx.store.run(investmentsCommands.markReviewDone, { module: "investments" }).ok,
        ).toBe(true);
        return { wrong: "unlabelled" } as unknown as LabelledTree;
      },
    });
    const result = await new NativeMcpServer(s.runtime, [spec]).call("write");
    expect(result.errorKind).toBe("unlabelled");
    expect(s.f.store.read("SELECT COUNT(*) AS n FROM reviews")).toEqual([{ n: 0 }]);
    expect(s.audit).toEqual(["start:write:{}", "finish:strict:refused"]);
  });
  it("audits before a successful write and appends only after validation", async () => {
    const s = setup();
    const spec = toolSpec<NativeToolStore>({
      name: "write",
      description: "Synthetic write",
      module: "core",
      write: true,
      handler: (ctx) => {
        expect(s.audit).toEqual(["start:write:{}"]);
        ctx.store.run(investmentsCommands.markReviewDone, { module: "investments" });
        return { saved: count(1) };
      },
    });
    expect((await new NativeMcpServer(s.runtime, [spec]).call("write")).ok).toBe(true);
    expect(s.f.store.read("SELECT COUNT(*) AS n FROM reviews")).toEqual([{ n: 1 }]);
    expect(s.audit).toEqual(["start:write:{}", "commit", "finish:strict:ok"]);
  });
  it("does not run handlers without audit or after bundle replacement", async () => {
    const s = setup();
    let calls = 0;
    const server = new NativeMcpServer(s.runtime, [
      toolSpec({
        name: "read",
        description: "Synthetic read",
        module: "core",
        handler: () => {
          calls++;
          return { n: count(1) };
        },
      }),
    ]);
    s.failAudit();
    expect((await server.call("read")).errorKind).toBe("audit_unavailable");
    s.replace();
    expect((await server.call("read")).errorKind).toBe("app_updated");
    expect(calls).toBe(0);
    expect(s.audit).toEqual([]);
  });
  it("does not persist unknown argument names or values", async () => {
    const s = setup();
    await new NativeMcpServer(s.runtime, []).call("invented-sensitive-name", {
      "private argument": "private value",
    });
    expect(s.audit[0]).toBe('start:(unknown):{"_unknown":1}');
  });
});
it("renders Python-compatible indented JSON without losing integers", () => {
  expect(resultText({ n: 1n, x: 1, rows: [] })).toBe('{\n "n": 1,\n "x": 1.0,\n "rows": []\n}');
});
