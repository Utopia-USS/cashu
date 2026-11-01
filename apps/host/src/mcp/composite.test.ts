import {
  BRIDGE_CAPABILITY,
  CEILING_KEY,
  EFFECTIVE_PRIVACY_KEY,
  NAME_GUARD_APPLIED_KEY,
  NAME_GUARD_KEY,
  NativeMcpServer,
  type NativeRuntime,
  type Privacy,
  toolSpec,
} from "@cashu/mcp";
import { describe, expect, it, vi } from "vitest";
import { compositeBackend } from "./composite.js";
import type { McpBackend } from "./session.js";

type Json = Record<string, unknown>;
const metadata = [
  { name: "profile_overview", module: "core", also: [] },
  { name: "spending_breakdown", module: "budget", also: [] },
];
function fixture(
  options: { bridge?: boolean; acknowledge?: boolean; pythonPrivacy?: Privacy } = {},
) {
  let privacy: Privacy = "amounts";
  let modules = new Set(["budget"]);
  let replaced = false;
  const audits: string[] = [];
  const calls: Json[] = [];
  const messages: Json[] = [];
  let childLine: (line: string) => void = () => {};
  let childExit: (code: number) => void = () => {};
  const python: McpBackend = {
    send(line) {
      const msg = JSON.parse(line) as Json;
      messages.push(msg);
      const params = (msg.params ?? {}) as Json;
      if (!Object.hasOwn(msg, "id")) return;
      let result: Json = {};
      if (msg.method === "initialize")
        result = {
          capabilities: {
            tools: {},
            experimental:
              options.bridge === false
                ? {}
                : { [BRIDGE_CAPABILITY]: { privacyCeiling: true, nameGuard: true } },
          },
          serverInfo: { name: "cashu-synthetic", version: "test" },
        };
      if (msg.method === "tools/list")
        result = {
          tools: metadata.map((m) => ({
            name: m.name,
            description: `python ${m.name}`,
            inputSchema: {
              type: "object",
              properties: { currency: { type: "string" } },
              required: [],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          })),
        };
      if (msg.method === "tools/call") {
        calls.push(params);
        const meta = params._meta as Json;
        const effective =
          options.pythonPrivacy === "strict" || meta[CEILING_KEY] === "strict"
            ? "strict"
            : "amounts";
        result = {
          content: [{ type: "text", text: effective }],
          structuredContent: { mode: effective },
          isError: false,
          ...(options.acknowledge === false
            ? {}
            : { _meta: { [EFFECTIVE_PRIVACY_KEY]: effective, [NAME_GUARD_APPLIED_KEY]: true } }),
        };
      }
      queueMicrotask(() => childLine(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })));
    },
    endInput() {
      childExit(0);
    },
    onLine(fn) {
      childLine = fn;
    },
    onStderr() {},
    onExit(fn) {
      childExit = fn;
    },
    async close() {
      childExit(0);
    },
  };
  const runtime: NativeRuntime = {
    now: () => 1,
    replaced: () => replaced,
    warn: (code) => audits.push(code),
    policy: async () => ({ privacy, modules }),
    delegation: async () => ({
      privacy,
      modules,
      names: { persons: [], strongNames: ["Native Guard"], privatePayees: [], strictNames: [] },
    }),
    execute: async (_ceiling, fn) => fn(undefined),
    audit: {
      start: async (name, args) => {
        audits.push(`start:${name}:${JSON.stringify(args)}`);
        return 1;
      },
      finish: async (_id, level, outcome) => {
        audits.push(`finish:${level}:${outcome}`);
      },
    },
  };
  const native = new NativeMcpServer(runtime, [
    toolSpec({
      name: "profile_overview",
      module: "core",
      description: "native profile",
      handler: () => ({}),
    }),
  ]);
  const backend = compositeBackend({ native, python, inventory: metadata, profile: "synthetic" });
  const received = new Map<string, Json>();
  const waiters = new Map<string, (msg: Json) => void>();
  backend.onLine((line) => {
    const msg = JSON.parse(line) as Json;
    const key = JSON.stringify(msg.id);
    const waiter = waiters.get(key);
    if (waiter) {
      waiters.delete(key);
      waiter(msg);
    } else received.set(key, msg);
  });
  const rpc = (id: string | number, method: string, params: Json = {}): Promise<Json> => {
    const key = JSON.stringify(id);
    return new Promise((resolve) => {
      waiters.set(key, resolve);
      backend.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  };
  const initialize = async () => {
    await rpc("init", "initialize", {});
    backend.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  };
  return {
    backend,
    rpc,
    initialize,
    calls,
    messages,
    audits,
    received,
    privacy: (value: Privacy) => {
      privacy = value;
    },
    modules: (value: string[]) => {
      modules = new Set(value);
    },
    replace: () => {
      replaced = true;
    },
  };
}
const body = (reply: Json) => reply.result as Json;
const content = (reply: Json) => (body(reply).content as { text: string }[])[0]?.text;

describe("mixed native/Python MCP", () => {
  it("rejects malformed request envelopes before audit or execution", async () => {
    const f = fixture();
    await f.initialize();
    const params = { name: "spending_breakdown", arguments: {} };
    const messages = f.messages.length;
    for (const packet of [
      { method: "tools/call", params },
      { jsonrpc: "2.0", method: "tools/call", params },
      { jsonrpc: "1.0", id: 1, method: "tools/call", params },
      { jsonrpc: "2.0", id: {}, method: "tools/call", params },
      { jsonrpc: "2.0", id: null, method: "tools/call", params },
      { jsonrpc: "2.0", id: 1.5, method: "tools/call", params },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: [] },
    ]) {
      f.backend.send(JSON.stringify(packet));
      expect(f.received.get("null")).toMatchObject({ error: { code: -32600 } });
    }
    expect(f.audits).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.messages).toHaveLength(messages);
    await f.backend.close();
  });
  it("does not accept initialized notification without negotiating initialization", async () => {
    const f = fixture();
    f.backend.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(await f.rpc(1, "tools/call", { name: "spending_breakdown" })).toMatchObject({
      error: { code: -32000 },
    });
    expect(f.audits).toEqual([]);
    expect(f.calls).toEqual([]);
    await f.backend.close();
  });
  it("checks raw numeric request IDs without restricting nested argument IDs", async () => {
    const f = fixture();
    await f.initialize();
    const messages = f.messages.length;
    for (const id of [
      "9007199254740991.4",
      "-9007199254740991.4",
      "9007199254740993",
      "1.00000000000000001",
    ]) {
      f.received.delete("null");
      f.backend.send(
        `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"spending_breakdown"}}`,
      );
      expect(f.received.get("null")).toMatchObject({ error: { code: -32600 } });
    }
    expect(f.audits).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.messages).toHaveLength(messages);
    const reply = await f.rpc(Number.MAX_SAFE_INTEGER, "tools/call", {
      name: "spending_breakdown",
      arguments: { id: Number.MAX_VALUE },
    });
    expect(reply.id).toBe(Number.MAX_SAFE_INTEGER);
    expect(f.calls[0]?.arguments).toEqual({ id: Number.MAX_VALUE });
    await f.backend.close();
  });
  it("refuses numeric IDs without parse source context while preserving string IDs", async () => {
    const f = fixture();
    await f.initialize();
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((source, reviver) =>
      parse(source, function (key, value) {
        return reviver ? reviver.call(this, key, value) : value;
      }),
    );
    try {
      f.backend.send(
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"spending_breakdown"}}',
      );
      expect(f.received.get("null")).toMatchObject({ error: { code: -32600 } });
      expect(f.audits).toEqual([]);
      expect(f.calls).toEqual([]);
      expect((await f.rpc("safe-string", "tools/call", { name: "spending_breakdown" })).id).toBe(
        "safe-string",
      );
    } finally {
      spy.mockRestore();
      await f.backend.close();
    }
  });
  it("rejects duplicate in-flight ids but permits reuse after a response", async () => {
    const f = fixture();
    await f.initialize();
    const first = f.rpc(1, "tools/call", { name: "spending_breakdown" });
    f.backend.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "spending_breakdown" },
      }),
    );
    expect(f.received.get("null")).toMatchObject({ error: { code: -32600 } });
    expect((await first).id).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect((await f.rpc(1, "tools/call", { name: "spending_breakdown" })).id).toBe(1);
    expect(f.calls).toHaveLength(2);
    await f.backend.close();
  });
  it("replaces native descriptors and preserves the rest in provider order", async () => {
    const f = fixture();
    await f.initialize();
    const tools = body(await f.rpc(1, "tools/list")).tools as Json[];
    expect(tools.map((row) => row.name)).toEqual(metadata.map((row) => row.name));
    expect(tools[0]?.description).toBe("native profile");
    f.modules([]);
    expect((body(await f.rpc(2, "tools/list")).tools as Json[]).map((row) => row.name)).toEqual([
      "profile_overview",
    ]);
    await f.backend.close();
  });
  it("clamps each delegated call to freshly read native policy and stricter caller policy", async () => {
    const f = fixture();
    await f.initialize();
    expect(content(await f.rpc(1, "tools/call", { name: "spending_breakdown" }))).toBe("amounts");
    f.privacy("strict");
    expect(
      content(
        await f.rpc("1", "tools/call", {
          name: "spending_breakdown",
          _meta: { [CEILING_KEY]: "amounts" },
        }),
      ),
    ).toBe("strict");
    f.privacy("amounts");
    const reply = await f.rpc(3, "tools/call", {
      name: "spending_breakdown",
      _meta: { [CEILING_KEY]: "strict" },
    });
    expect(content(reply)).toBe("strict");
    expect(body(reply)._meta).toBeUndefined();
    const spoofed = await f.rpc(4, "tools/call", {
      name: "spending_breakdown",
      _meta: { [NAME_GUARD_KEY]: { strongNames: [] } },
    });
    expect(body(spoofed).isError).toBe(false);
    expect(((f.calls.at(-1)?._meta ?? {}) as Json)[NAME_GUARD_KEY]).toEqual({
      persons: [],
      strongNames: ["Native Guard"],
      privatePayees: [],
      strictNames: [],
    });
    expect(f.audits).toContain("finish:strict:ok");
    await f.backend.close();
  });
  it("audits Python's stricter policy rather than claiming amounts", async () => {
    const f = fixture({ pythonPrivacy: "strict" });
    await f.initialize();
    expect(content(await f.rpc(1, "tools/call", { name: "spending_breakdown" }))).toBe("strict");
    expect(f.audits).toContain("finish:strict:ok");
    await f.backend.close();
  });
  it("refuses old backends, missing acknowledgements and disabled modules", async () => {
    const old = fixture({ bridge: false });
    await old.initialize();
    expect(body(await old.rpc(1, "tools/call", { name: "spending_breakdown" })).isError).toBe(true);
    expect(old.calls).toHaveLength(0);
    await old.backend.close();
    const missing = fixture({ acknowledge: false });
    await missing.initialize();
    expect(content(await missing.rpc(1, "tools/call", { name: "spending_breakdown" }))).toContain(
      "withheld",
    );
    await missing.backend.close();
    const disabled = fixture();
    await disabled.initialize();
    disabled.modules([]);
    expect(content(await disabled.rpc(1, "tools/call", { name: "spending_breakdown" }))).toContain(
      "not enabled",
    );
    expect(disabled.calls).toHaveLength(0);
    await disabled.backend.close();
  });
  it("refuses malformed metadata and a replaced bundle before tool execution", async () => {
    const f = fixture();
    await f.initialize();
    expect(
      body(
        await f.rpc(1, "tools/call", {
          name: "spending_breakdown",
          _meta: { [CEILING_KEY]: null },
        }),
      ).isError,
    ).toBe(true);
    f.replace();
    const before = f.audits.length;
    const messages = f.messages.length;
    expect(content(await f.rpc(2, "tools/call", { name: "spending_breakdown" }))).toContain(
      "updated",
    );
    expect(f.audits).toHaveLength(before);
    expect(f.calls).toHaveLength(0);
    expect(f.messages).toHaveLength(messages);
    await f.backend.close();
  });
  it("keeps concurrent client ids distinct from private forwarded ids", async () => {
    const f = fixture();
    await f.initialize();
    const replies = await Promise.all([
      f.rpc("cashu-private-2", "tools/call", { name: "spending_breakdown" }),
      f.rpc(1, "tools/call", { name: "spending_breakdown" }),
      f.rpc("1", "tools/call", { name: "spending_breakdown" }),
    ]);
    expect(replies.map((r) => r.id)).toEqual(["cashu-private-2", 1, "1"]);
    await f.backend.close();
  });
});
