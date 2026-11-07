// Native-only MCP JSON-RPC transport. Tool policy, privacy and durable writes live in NativeMcpServer.
import { randomBytes } from "node:crypto";
import {
  failure,
  INSTRUCTIONS,
  type NativeCallResult,
  type NativeMcpServer,
  privacyCeiling,
  resultText,
  type ToolInventoryEntry,
  type ToolMetadata,
} from "@cashu/mcp";
import { mcpServerName, processFlavor } from "@cashu/node-host/flavor";
import { mintUlid } from "@cashu/store";
import type { McpBackend } from "./session.js";

type Json = Record<string, unknown>;
const REQUEST_KEY_META = "cashu/idempotencyKey";
const WRITE_OUTCOME_META = "cashu/writeOutcome";
const WRITE_STATUS_TOOL = "cashu_write_status";
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const validId = (value: unknown): value is string | number =>
  typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
const validKey = (value: unknown): value is string =>
  typeof value === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value);

function wireJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map((part) => wireJson(part ?? null)).join(",")}]`;
  const record = object(value);
  if (record)
    return `{${Object.entries(record)
      .filter(([, part]) => part !== undefined)
      .map(([key, part]) => `${JSON.stringify(key)}:${wireJson(part)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function publicResult(result: NativeCallResult): Json {
  return result.ok
    ? {
        content: [{ type: "text", text: resultText(result.data ?? null) }],
        structuredContent: result.data,
        isError: false,
        ...(result.requestKey === undefined
          ? {}
          : { _meta: { [WRITE_OUTCOME_META]: { kind: "completed", key: result.requestKey } } }),
      }
    : {
        content: [{ type: "text", text: result.error ?? "error" }],
        isError: true,
        ...(result.requestKey === undefined
          ? {}
          : {
              _meta: {
                [WRITE_OUTCOME_META]: {
                  kind: result.errorKind === "response_withheld" ? "completed" : "outcome_unknown",
                  key: result.requestKey,
                },
              },
            }),
      };
}

export function nativeBackend(options: {
  readonly native: NativeMcpServer;
  readonly inventory: readonly (ToolInventoryEntry & Partial<Pick<ToolMetadata, "properties">>)[];
  readonly profile: string;
  readonly version?: string;
}): McpBackend {
  const { native } = options;
  const metadata = new Map(options.inventory.map((entry) => [entry.name, entry]));
  const tasks = new Set<Promise<void>>();
  const activeIds = new Map<string, symbol>();
  let onLine: (line: string) => void = () => {};
  let onExit: (code: number) => void = () => {};
  let closed = false;
  let ending = false;
  let negotiated = false;
  let initialized = false;
  const emit = (message: Json) => {
    if (!Object.hasOwn(message, "method") && validId(message.id))
      activeIds.delete(JSON.stringify(message.id));
    if (!closed) onLine(wireJson(message));
  };
  const reply = (id: unknown, result: unknown) => emit({ jsonrpc: "2.0", id, result });

  async function list(id: unknown) {
    if (native.runtime.replaced()) return reply(id, { tools: [] });
    const policy = await native.runtime.policy();
    const own = new Map((await native.list()).map((tool) => [tool.name, tool]));
    const tools = options.inventory.flatMap((entry) => {
      if (
        !policy ||
        (entry.module !== "core" &&
          !policy.modules.has(entry.module) &&
          !entry.also.some((module) => policy.modules.has(module)))
      )
        return [];
      const tool = own.get(entry.name);
      return tool === undefined ? [] : [tool];
    });
    if (policy && native.runtime.writeStatus)
      tools.push({
        name: WRITE_STATUS_TOOL,
        description: "Read only status of an original cashU write key in this profile",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string", pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$" } },
          required: ["key"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      });
    reply(id, { tools });
  }

  async function call(id: unknown, params: Json) {
    const name = typeof params.name === "string" ? params.name : "";
    const known = new Set(Object.keys(metadata.get(name)?.properties ?? {}));
    const invalid = async (message: string, kind: string, args: Json | null) => {
      const result = await native.audited(
        metadata.has(name) ? name : "(unknown)",
        args,
        known,
        async () => failure(message, kind),
      );
      reply(id, publicResult(result));
    };
    if (
      params.arguments !== undefined &&
      params.arguments !== null &&
      object(params.arguments) === undefined
    )
      return invalid("tool arguments must be an object", "invalid_arguments", null);
    const args = object(params.arguments) ?? null;
    let ceiling: ReturnType<typeof privacyCeiling>;
    try {
      ceiling = privacyCeiling(params._meta);
    } catch {
      return invalid("invalid private policy metadata", "invalid_policy", args);
    }
    if (name === WRITE_STATUS_TOOL) {
      const key = args?.key;
      const result = await native.audited(name, args, new Set(["key"]), async () => {
        if (!validKey(key) || Object.keys(args ?? {}).length !== 1)
          return failure("invalid write key", "invalid_arguments");
        const status = await native.runtime.writeStatus?.(key);
        return {
          ok: true,
          privacy: "strict" as const,
          data: status ?? { kind: "outcome_unknown" },
        };
      });
      return reply(id, publicResult(result));
    }
    const supplied = object(params._meta)?.[REQUEST_KEY_META];
    if (supplied !== undefined && !validKey(supplied))
      return invalid("invalid idempotency key", "invalid_arguments", args);
    const key = supplied ?? mintUlid(Date.now(), (length) => new Uint8Array(randomBytes(length)));
    const result = await native.call(name, args, ceiling, key);
    reply(id, publicResult(result));
    if (result.errorKind === "app_updated") ending = true;
  }

  async function dispatch(message: Json) {
    const method = message.method;
    if (method === "initialize" || method === "server/discover") {
      negotiated = true;
      if (method === "server/discover") initialized = true;
      return reply(message.id, {
        protocolVersion: object(message.params)?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: mcpServerName(processFlavor(), options.profile),
          version: options.version ?? "0.4.6",
        },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === "notifications/initialized") {
      if (negotiated) initialized = true;
      return;
    }
    if ((method === "tools/list" || method === "tools/call") && !initialized)
      return emit({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Server is not initialized" },
      });
    if (method === "tools/list") return list(message.id);
    if (method === "tools/call") return call(message.id, object(message.params) ?? {});
    if (method === "ping") return reply(message.id, {});
    if (typeof method === "string" && !Object.hasOwn(message, "id")) return;
    emit({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }

  function finishInput() {
    if (!ending || tasks.size > 0 || closed) return;
    closed = true;
    onExit(0);
  }
  return {
    send(line) {
      if (closed || ending) return;
      let message: Json | undefined;
      const numericIds = new WeakMap<object, string | undefined>();
      try {
        message = object(
          JSON.parse(
            line,
            function (this: object, key: string, value: unknown, context?: { source?: string }) {
              if (key === "id" && typeof value === "number") numericIds.set(this, context?.source);
              return value;
            },
          ),
        );
      } catch {
        emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      if (!message) {
        emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        return;
      }
      const hasId = Object.hasOwn(message, "id");
      const idValid =
        validId(message.id) &&
        (typeof message.id !== "number" ||
          /^-?(?:0|[1-9]\d{0,15})$/.test(numericIds.get(message) ?? ""));
      const key = JSON.stringify(message.id);
      const notification =
        typeof message.method === "string" && message.method.startsWith("notifications/");
      if (
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string" ||
        notification === hasId ||
        (hasId && !idValid) ||
        (Object.hasOwn(message, "params") && object(message.params) === undefined) ||
        (hasId && activeIds.has(key))
      ) {
        emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        return;
      }
      const token = Symbol();
      if (hasId) activeIds.set(key, token);
      const task = dispatch(message)
        .catch(() => {
          emit({
            jsonrpc: "2.0",
            id: message?.id ?? null,
            error: { code: -32603, message: "Internal error" },
          });
        })
        .finally(() => {
          if (activeIds.get(key) === token) activeIds.delete(key);
          tasks.delete(task);
          finishInput();
        });
      tasks.add(task);
    },
    endInput() {
      ending = true;
      finishInput();
    },
    onLine(handler) {
      onLine = handler;
    },
    onStderr(_handler) {},
    onExit(handler) {
      onExit = handler;
    },
    async close() {
      closed = true;
      native.invalidateAsync();
      await Promise.allSettled(tasks);
    },
    async prepareHandover() {
      ending = true;
      native.invalidateAsync();
      await Promise.allSettled([...tasks]);
      finishInput();
    },
  };
}
