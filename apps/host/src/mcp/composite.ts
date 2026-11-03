// Native tools replace their Python counterparts by name. Remaining tools use a restrictive private
// policy bridge; an older Python child cannot silently ignore the host's per-call privacy ceiling.
import { randomBytes } from "node:crypto";
import {
  APP_UPDATED,
  BRIDGE_CAPABILITY,
  CEILING_KEY,
  EFFECTIVE_PRIVACY_KEY,
  failure,
  INSTRUCTIONS,
  NAME_GUARD_APPLIED_KEY,
  NAME_GUARD_KEY,
  type NativeCallResult,
  type NativeMcpServer,
  privacyCeiling,
  restrictivePrivacy,
  resultText,
  type ToolDescriptor,
  type ToolInventoryEntry,
  type ToolMetadata,
} from "@cashu/mcp";
import { mintUlid } from "@cashu/store";
import type { McpBackend } from "./session.js";

type Json = Record<string, unknown>;
const REQUEST_KEY_META = "cashu/idempotencyKey";
const WRITE_OUTCOME_META = "cashu/writeOutcome";
const WRITE_STATUS_TOOL = "cashu_write_status";
const validRequestKey = (value: unknown): value is string =>
  typeof value === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value);
const object = (v: unknown): Json | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const validId = (value: unknown): value is string | number =>
  typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
function wireJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map((v) => wireJson(v ?? null)).join(",")}]`;
  const obj = object(value);
  if (obj)
    return `{${Object.entries(obj)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${wireJson(v)}`)
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
export interface CompositeOptions {
  readonly native: NativeMcpServer;
  readonly python?: McpBackend;
  readonly inventory: readonly (ToolInventoryEntry & Partial<Pick<ToolMetadata, "properties">>)[];
  readonly profile: string;
  readonly version?: string;
}
export function compositeBackend(options: CompositeOptions): McpBackend {
  const { native, python } = options;
  let onLine: (line: string) => void = () => {};
  let onStderr: (line: string) => void = () => {};
  let onExit: (code: number) => void = () => {};
  let closed = false;
  let bridge = false;
  let next = 0;
  let ending = false;
  let initialized = false;
  let negotiated = false;
  const tasks = new Set<Promise<void>>();
  const pending = new Map<string, (value: Json) => void>();
  const externalIds = new Map<string, string>();
  const activeIds = new Map<string, symbol>();
  const serverRequests = new Set<string>();
  const descriptors = new Map<string, ToolDescriptor>();
  const metadata = new Map(options.inventory.map((entry) => [entry.name, entry]));
  const emit = (msg: Json) => {
    if (!Object.hasOwn(msg, "method") && validId(msg.id)) activeIds.delete(JSON.stringify(msg.id));
    if (!closed) onLine(wireJson(msg));
  };
  const ask = (method: string, params: unknown, clientId?: unknown): Promise<Json> => {
    if (!python || closed)
      return Promise.resolve({ error: { code: -32603, message: "Python backend unavailable" } });
    const id = `cashu-private-${++next}`;
    if (clientId !== undefined) externalIds.set(JSON.stringify(clientId), id);
    return new Promise<Json>((resolve) => {
      pending.set(id, resolve);
      python.send(wireJson({ jsonrpc: "2.0", id, method, params }));
    }).finally(() => {
      if (clientId !== undefined) externalIds.delete(JSON.stringify(clientId));
    });
  };
  const remember = (message: Json) => {
    const result = object(message.result);
    const tools = result?.tools;
    if (!Array.isArray(tools)) return;
    descriptors.clear();
    for (const tool of tools) {
      const row = object(tool);
      if (typeof row?.name === "string" && metadata.has(row.name))
        descriptors.set(row.name, row as unknown as ToolDescriptor);
    }
  };
  python?.onLine((line) => {
    let msg: Json | undefined;
    try {
      msg = object(JSON.parse(line));
    } catch {
      return;
    }
    if (!msg) return;
    if (typeof msg.method === "string") {
      if (validId(msg.id)) serverRequests.add(JSON.stringify(msg.id));
      emit(msg);
      return;
    }
    if (typeof msg.id === "string") {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
        return;
      }
    }
  });
  python?.onStderr((line) => onStderr(line));
  python?.onExit((code) => {
    for (const resolve of pending.values())
      resolve({ error: { code: -32603, message: "Python backend stopped" } });
    pending.clear();
    if (!closed) {
      closed = true;
      native.invalidateAsync();
      onExit(code);
    }
  });
  async function initialize(msg: Json, method: string) {
    if (python) {
      const reply = await ask(method, msg.params);
      const result = object(reply.result);
      const caps = object(result?.capabilities);
      const experimental = object(caps?.experimental);
      const support = object(experimental?.[BRIDGE_CAPABILITY]);
      bridge = support?.privacyCeiling === true && support?.nameGuard === true;
      if (result) result.instructions = INSTRUCTIONS;
      if (result) negotiated = true;
      if (method === "server/discover" && result) initialized = true;
      emit({ ...reply, id: msg.id });
    } else {
      negotiated = true;
      if (method === "server/discover") initialized = true;
      emit({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: object(msg.params)?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: `cashu-${options.profile}`, version: options.version ?? "0.4.6" },
          instructions: INSTRUCTIONS,
        },
      });
    }
  }
  async function list(msg: Json) {
    if (native.runtime.replaced()) {
      emit({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
      return;
    }
    if (python) remember(await ask("tools/list", msg.params ?? {}));
    const policy = await native.runtime.policy();
    const own = new Map((await native.list()).map((row) => [row.name, row]));
    const listed = options.inventory.flatMap((entry) => {
      if (
        !policy ||
        (entry.module !== "core" &&
          !policy.modules.has(entry.module) &&
          !entry.also.some((m) => policy.modules.has(m)))
      )
        return [];
      const row = own.get(entry.name) ?? descriptors.get(entry.name);
      return row === undefined ? [] : [row];
    });
    if (policy && native.runtime.writeStatus)
      listed.push({
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
    emit({ jsonrpc: "2.0", id: msg.id, result: { tools: listed } });
  }
  async function call(msg: Json) {
    const params = object(msg.params) ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    if (
      params.arguments !== undefined &&
      params.arguments !== null &&
      object(params.arguments) === undefined
    ) {
      const invalid = await native.audited(
        metadata.has(name) ? name : "(unknown)",
        null,
        new Set(),
        async () => failure("tool arguments must be an object", "invalid_arguments"),
      );
      emit({ jsonrpc: "2.0", id: msg.id, result: publicResult(invalid) });
      return;
    }
    const args = object(params.arguments) ?? null;
    let ceiling: ReturnType<typeof privacyCeiling>;
    try {
      ceiling = privacyCeiling(params._meta);
    } catch {
      const invalid = await native.audited(
        metadata.has(name) ? name : "(unknown)",
        args,
        new Set(),
        async () => failure("invalid private policy metadata", "invalid_policy"),
      );
      emit({ jsonrpc: "2.0", id: msg.id, result: publicResult(invalid) });
      return;
    }
    if (name === WRITE_STATUS_TOOL) {
      const key = args?.key;
      const result = await native.audited(name, args, new Set(["key"]), async () => {
        if (!validRequestKey(key) || Object.keys(args ?? {}).length !== 1)
          return failure("invalid write key", "invalid_arguments");
        const status = await native.runtime.writeStatus?.(key);
        return {
          ok: true,
          privacy: "strict",
          data: status ?? { kind: "outcome_unknown" },
        };
      });
      emit({ jsonrpc: "2.0", id: msg.id, result: publicResult(result) });
      return;
    }
    if (native.tools.has(name) || !metadata.has(name)) {
      const supplied = object(params._meta)?.[REQUEST_KEY_META];
      if (supplied !== undefined && !validRequestKey(supplied)) {
        const invalid = await native.audited(
          metadata.has(name) ? name : "(unknown)",
          args,
          new Set(Object.keys(metadata.get(name)?.properties ?? {})),
          async () => failure("invalid idempotency key", "invalid_arguments"),
        );
        emit({
          jsonrpc: "2.0",
          id: msg.id,
          result: publicResult(invalid),
        });
        return;
      }
      const key = supplied ?? mintUlid(Date.now(), (n) => new Uint8Array(randomBytes(n)));
      const result = await native.call(name, args, ceiling, key);
      emit({ jsonrpc: "2.0", id: msg.id, result: publicResult(result) });
      if (result.errorKind === "app_updated") ending = true;
      return;
    }
    if (object(params._meta)?.[REQUEST_KEY_META] !== undefined) {
      const unsupported = await native.audited(
        name,
        args,
        new Set(Object.keys(metadata.get(name)?.properties ?? {})),
        async () => failure("idempotency keys require a native tool", "unsupported"),
      );
      emit({ jsonrpc: "2.0", id: msg.id, result: publicResult(unsupported) });
      return;
    }
    const entry = metadata.get(name) as ToolInventoryEntry &
      Partial<Pick<ToolMetadata, "properties">>;
    // The reviewed catalog supplies declared names without touching Python before the audit.
    const known = new Set(Object.keys(entry.properties ?? {}));
    let forwarded: Json | undefined;
    const result = await native.audited(name, args, known, async () => {
      const policy = await native.runtime.delegation();
      if (native.runtime.replaced()) return failure(APP_UPDATED, "app_updated");
      if (!policy) return failure("the profile of this server no longer exists", "profile_missing");
      const effective = restrictivePrivacy(policy.privacy, ceiling);
      if (
        entry.module !== "core" &&
        !policy.modules.has(entry.module) &&
        !entry.also.some((m) => policy.modules.has(m))
      )
        return failure(
          `tool ${name} belongs to the module '${entry.module}', which is not enabled for this profile`,
          "module_disabled",
          effective,
        );
      if (!python || !bridge)
        return failure(
          "the delegated tool was not run: reconnect using a Python server with host policy support",
          "bridge_unavailable",
          effective,
        );
      if (native.runtime.replaced()) return failure(APP_UPDATED, "app_updated");
      const meta = {
        ...object(params._meta),
        [CEILING_KEY]: effective,
        [NAME_GUARD_KEY]: policy.names,
      };
      const reply = await ask("tools/call", { ...params, _meta: meta }, msg.id);
      const body = object(reply.result);
      const reported = object(body?._meta)?.[EFFECTIVE_PRIVACY_KEY];
      const namesApplied = object(body?._meta)?.[NAME_GUARD_APPLIED_KEY] === true;
      // A missing acknowledgement is a protocol failure, never permission to forward an answer.
      if (
        !body ||
        !namesApplied ||
        (reported !== "strict" && reported !== "amounts") ||
        (effective === "strict" && reported !== "strict")
      )
        return failure(
          "the delegated answer was withheld: private policy acknowledgement missing",
          "bridge_unavailable",
          effective,
        );
      const publicMeta = { ...object(body._meta) };
      delete publicMeta[EFFECTIVE_PRIVACY_KEY];
      delete publicMeta[NAME_GUARD_APPLIED_KEY];
      forwarded = { ...body };
      delete forwarded._meta;
      if (Object.keys(publicMeta).length > 0) forwarded._meta = publicMeta;
      return {
        ok: body.isError !== true,
        privacy: reported,
        ...(body.isError === true ? { errorKind: "delegated_error" } : {}),
      };
    });
    emit({ jsonrpc: "2.0", id: msg.id, result: forwarded ?? publicResult(result) });
    if (result.errorKind === "app_updated") ending = true;
  }
  async function dispatch(msg: Json) {
    const method = msg.method;
    if (method === "initialize" || method === "server/discover") return initialize(msg, method);
    if (method === "notifications/initialized") {
      if (!negotiated) return;
      initialized = true;
      python?.send(wireJson(msg));
      return;
    }
    if ((method === "tools/list" || method === "tools/call") && !initialized) {
      emit({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "Server is not initialized" },
      });
      return;
    }
    if (method === "tools/list") return list(msg);
    if (method === "tools/call") return call(msg);
    if (method === "ping") {
      emit({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    if (method === "notifications/cancelled") {
      const params = object(msg.params);
      const internalId =
        params === undefined ? undefined : externalIds.get(JSON.stringify(params.requestId));
      if (internalId !== undefined)
        python?.send(wireJson({ ...msg, params: { ...params, requestId: internalId } }));
      return;
    }
    if (typeof method === "string" && !Object.hasOwn(msg, "id")) {
      python?.send(wireJson(msg));
      return;
    }
    emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
  function finishInput() {
    if (!ending || tasks.size > 0 || closed) return;
    python?.endInput();
    if (!python) {
      closed = true;
      onExit(0);
    }
  }
  return {
    send(line) {
      if (closed || ending) return;
      let msg: Json | undefined;
      const numericIds = new WeakMap<object, string | undefined>();
      try {
        msg = object(
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
      if (!msg) {
        emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        return;
      }
      // Validate the original top-level protocol token before dispatch. JSON.parse can round a
      // fractional/out-of-range ID into a safe integer. Older runtimes without source context
      // refuse numeric IDs; string IDs still work. Nested tool argument IDs are unaffected.
      const idValid =
        validId(msg.id) &&
        (typeof msg.id !== "number" || /^-?(?:0|[1-9]\d{0,15})$/.test(numericIds.get(msg) ?? ""));
      const key = JSON.stringify(msg.id);
      if (
        msg.jsonrpc === "2.0" &&
        !Object.hasOwn(msg, "method") &&
        idValid &&
        serverRequests.has(key) &&
        Object.hasOwn(msg, "result") !== Object.hasOwn(msg, "error")
      ) {
        serverRequests.delete(key);
        python?.send(wireJson(msg));
        return;
      }
      const hasId = Object.hasOwn(msg, "id");
      const notification =
        typeof msg.method === "string" && msg.method.startsWith("notifications/");
      if (
        msg.jsonrpc !== "2.0" ||
        typeof msg.method !== "string" ||
        notification === hasId ||
        (hasId && !idValid) ||
        (Object.hasOwn(msg, "params") && object(msg.params) === undefined) ||
        (hasId && activeIds.has(key))
      ) {
        emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        return;
      }
      const token = Symbol();
      if (hasId) activeIds.set(key, token);
      const task = dispatch(msg)
        .catch(() => {
          emit({
            jsonrpc: "2.0",
            id: msg?.id ?? null,
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
    onStderr(handler) {
      onStderr = handler;
    },
    onExit(handler) {
      onExit = handler;
    },
    async close() {
      closed = true;
      native.invalidateAsync();
      await python?.close();
      for (const resolve of pending.values())
        resolve({ error: { code: -32603, message: "Session closed" } });
      pending.clear();
      await Promise.allSettled(tasks);
    },
    async prepareHandover() {
      ending = true;
      native.invalidateAsync();
      // Do not wait for a network-backed Python tool before draining native refusals. Its outcome
      // is unknown, so the response is withheld rather than claiming the call was never run.
      for (const resolve of pending.values())
        resolve({ error: { code: -32603, message: "Host is handing over" } });
      pending.clear();
      await Promise.allSettled([...tasks]);
      finishInput();
    },
  };
}
