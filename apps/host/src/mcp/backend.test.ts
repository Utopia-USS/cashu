import { NativeMcpServer, type NativeRuntime, toolSpec } from "@cashu/mcp";
import { describe, expect, it, vi } from "vitest";
import { nativeBackend } from "./backend.js";

type Json = Record<string, unknown>;
const key = "01K9B2W000000000000000000D";

function fixture(
  options: { writeStatus?: boolean; holdAudit?: Promise<void>; language?: () => "pl" | "en" } = {},
) {
  const audits: string[] = [];
  const received = new Map<string, Json>();
  const waiters = new Map<string, (message: Json) => void>();
  const runtime: NativeRuntime = {
    now: () => 1,
    replaced: () => false,
    warn: () => {},
    policy: async () => ({ privacy: "strict", modules: new Set<string>() }),
    ...(options.writeStatus
      ? { writeStatus: async () => ({ kind: "outcome_unknown" as const }) }
      : {}),
    execute: async (_ceiling, action) => action(undefined),
    audit: {
      start: async (name) => {
        audits.push(`start:${name}`);
        await options.holdAudit;
        return 1;
      },
      finish: async (_id, _privacy, outcome) => {
        audits.push(`finish:${outcome}`);
      },
    },
  };
  const native = new NativeMcpServer(runtime, [
    toolSpec({
      name: "profile_overview",
      module: "core",
      description: "synthetic profile",
      handler: () => ({}),
    }),
  ]);
  const backend = nativeBackend({
    native,
    inventory: [{ name: "profile_overview", module: "core", also: [] }],
    profile: "synthetic",
    ...(options.language ? { language: options.language } : {}),
  });
  backend.onLine((line) => {
    const message = JSON.parse(line) as Json;
    const id = JSON.stringify(message.id);
    const waiter = waiters.get(id);
    if (waiter) {
      waiters.delete(id);
      waiter(message);
    } else received.set(id, message);
  });
  const rpc = (id: string | number, method: string, params: Json = {}): Promise<Json> =>
    new Promise((resolve) => {
      waiters.set(JSON.stringify(id), resolve);
      backend.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  const initialize = async () => {
    await rpc("init", "initialize");
    backend.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  };
  return { backend, native, audits, received, rpc, initialize };
}

const body = (reply: Json) => reply.result as Json;

describe("native MCP JSON-RPC backend", () => {
  it("names the app language the owner reads cashU in, read when a session starts", async () => {
    let language: "pl" | "en" = "pl";
    const f = fixture({ language: () => language });
    const polish = body(await f.rpc("a", "initialize")).instructions as string;
    expect(polish).toContain("The app language is Polish (pl)");
    language = "en";
    const english = body(await f.rpc("b", "initialize")).instructions as string;
    expect(english).toContain("The app language is English (en)");
    expect(english).not.toContain("Polish (pl)");
    const plain = fixture();
    expect(body(await plain.rpc("c", "initialize")).instructions).not.toMatch(/app language/u);
    await f.backend.close();
    await plain.backend.close();
  });

  it("passes an original write key and exposes status without receipts", async () => {
    const f = fixture({ writeStatus: true });
    await f.initialize();
    const called = vi.spyOn(f.native, "call").mockResolvedValue({
      ok: false,
      privacy: "strict",
      error: "write outcome unknown",
      errorKind: "outcome_unknown",
      requestKey: key,
    });
    const response = body(
      await f.rpc(1, "tools/call", {
        name: "profile_overview",
        _meta: { "cashu/idempotencyKey": key },
      }),
    );
    expect(called.mock.calls[0]?.[3]).toBe(key);
    expect(response).toMatchObject({
      isError: true,
      _meta: { "cashu/writeOutcome": { kind: "outcome_unknown", key } },
    });
    for (const invalid of ["invalid", `8${key.slice(1)}`]) {
      expect(
        body(
          await f.rpc(invalid, "tools/call", {
            name: "profile_overview",
            _meta: { "cashu/idempotencyKey": invalid },
          }),
        ).isError,
      ).toBe(true);
    }
    expect(called).toHaveBeenCalledTimes(1);
    expect((body(await f.rpc(2, "tools/list")).tools as Json[]).map((tool) => tool.name)).toEqual([
      "profile_overview",
      "cashu_write_status",
    ]);
    const status = body(
      await f.rpc(3, "tools/call", { name: "cashu_write_status", arguments: { key } }),
    );
    expect(status.structuredContent).toEqual({ kind: "outcome_unknown" });
    expect(JSON.stringify(status)).not.toMatch(/eids|receipt/u);
    await f.backend.close();
  });

  it("rejects malformed envelopes before audit or execution", async () => {
    const f = fixture();
    await f.initialize();
    const params = { name: "profile_overview" };
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
    await f.backend.close();
  });

  it("requires initialization negotiation before tools calls", async () => {
    const f = fixture();
    f.backend.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(await f.rpc(1, "tools/call", { name: "profile_overview" })).toMatchObject({
      error: { code: -32000 },
    });
    expect(f.audits).toEqual([]);
    await f.backend.close();
  });

  it("validates raw numeric IDs while leaving nested argument IDs to tool validation", async () => {
    const f = fixture();
    await f.initialize();
    for (const id of [
      "9007199254740991.4",
      "-9007199254740991.4",
      "9007199254740993",
      "1.00000000000000001",
    ]) {
      f.received.delete("null");
      f.backend.send(
        `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"profile_overview"}}`,
      );
      expect(f.received.get("null")).toMatchObject({ error: { code: -32600 } });
    }
    expect(f.audits).toEqual([]);
    const called = vi
      .spyOn(f.native, "call")
      .mockResolvedValue({ ok: true, privacy: "strict", data: {} });
    const response = await f.rpc(Number.MAX_SAFE_INTEGER, "tools/call", {
      name: "profile_overview",
      arguments: { id: Number.MAX_VALUE },
    });
    expect(response.id).toBe(Number.MAX_SAFE_INTEGER);
    expect(called.mock.calls[0]?.[1]).toEqual({ id: Number.MAX_VALUE });
    await f.backend.close();
  });

  it("rejects duplicate in-flight IDs and permits reuse after response", async () => {
    let release = () => {};
    const holdAudit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({ holdAudit });
    await f.initialize();
    const first = f.rpc(1, "tools/call", { name: "profile_overview" });
    f.backend.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "profile_overview" },
      }),
    );
    expect(f.received.get("null")).toMatchObject({ error: { code: -32600 } });
    release();
    expect((await first).id).toBe(1);
    expect((await f.rpc(1, "tools/call", { name: "profile_overview" })).id).toBe(1);
    expect(f.audits.filter((event) => event === "start:profile_overview")).toHaveLength(2);
    await f.backend.close();
  });
});
