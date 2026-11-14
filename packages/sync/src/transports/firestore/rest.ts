// Firestore REST v1 client (M4-A): the small subset the relay transport needs (get, runQuery, an
// atomic commit with preconditions, delete) over one injected `fetch`. The same code runs on the
// phone (Hermes `fetch`), the Mac host (Node `fetch`), vitest (the in-memory fake) and the emulator
// (an http `baseUrl`, no other special casing).
//
// Errors are `FirestoreRestError` with a fixed, value-free message `firestore <code> <status> <verb>`:
// never a token, a request or response body, a document path or its bytes.
import { fromBase64, toBase64 } from "../../crypto/encoding.js";

/** The part of `fetch` this client uses; `globalThis.fetch` and the test fake both satisfy it. */
export interface FetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface FetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface FirestoreEndpoint {
  readonly projectId: string;
  /** Default "(default)". */
  readonly database?: string;
  /** "https://firestore.googleapis.com" by default; "http://127.0.0.1:8080" for the emulator (no trailing slash). */
  readonly baseUrl?: string;
}

export interface TokenSource {
  token(): Promise<string>;
  /** Drop a cached token after the server refused it (401); the next `token()` fetches a fresh one. */
  invalidate?(): void;
}

export interface FirestoreRestOptions {
  readonly endpoint: FirestoreEndpoint;
  readonly auth: TokenSource;
  /** Default `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /**
   * Base timeout per request (AbortController), default 10_000; a request body adds 1 s per 100 KiB
   * (`timeoutFor`), capped at 120 s. A call may pass its own `{ timeoutMs }` (a large expected response).
   */
  readonly timeoutMs?: number;
  /** Retries on a network error, timeout, 408, 429 or 5xx, default 1, with a 250-750 ms jitter. */
  readonly retries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Firestore JSON value encoding (only what we use). */
export type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { nullValue: null }
  /** base64 */
  | { bytesValue: string }
  /** RFC 3339 */
  | { timestampValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export interface FsDocument {
  /** Full resource name, "projects/<p>/databases/<db>/documents/<path>" (`relativeName` strips it). */
  readonly name: string;
  readonly fields: Record<string, FsValue>;
  readonly createTime?: string;
  readonly updateTime?: string;
}

export type FsPrecondition = { exists: boolean } | { updateTime: string };

/** `name` / `delete` may be a full resource name or a relative path; `commit` normalises both. */
export type FsWrite =
  | {
      update: { name: string; fields: Record<string, FsValue> };
      currentDocument?: FsPrecondition;
      updateMask?: { fieldPaths: string[] };
    }
  | { delete: string; currentDocument?: FsPrecondition };

interface FsFieldFilter {
  field: string;
  op: "EQUAL" | "GREATER_THAN" | "GREATER_THAN_OR_EQUAL" | "LESS_THAN";
  value: FsValue;
}

export interface FsQuery {
  collectionId: string;
  /** AND of all filters. */
  where?: FsFieldFilter[];
  orderBy?: { field: string; direction?: "ASCENDING" | "DESCENDING" }[];
  select?: string[];
  limit?: number;
}

export type FirestoreRestCode =
  | "unavailable"
  | "permission-denied"
  | "not-found"
  | "failed-precondition"
  | "aborted"
  | "resource-exhausted"
  | "invalid-argument"
  | "unauthenticated";

export class FirestoreRestError extends Error {
  readonly code: FirestoreRestCode;
  /** HTTP status, 0 for a network error, a timeout or a value that does not decode. */
  readonly status: number;
  constructor(code: FirestoreRestCode, status: number, verb: string) {
    super(`firestore ${code} ${status} ${verb}`);
    this.name = "FirestoreRestError";
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_BASE_URL = "https://firestore.googleapis.com";
const DEFAULT_TIMEOUT_MS = 10_000;
/** The slowest link a payload timeout allows for: 100 KiB per second (a weak phone connection). */
const PAYLOAD_BYTES_PER_SECOND = 100 * 1024;
const MAX_PAYLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 1;

/** One HTTP exchange: status and the parsed JSON body (undefined when empty or not JSON). */
export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * One request with a hard timeout: the signal aborts the fetch and a race makes sure even a fetch that
 * ignores the signal cannot hang the caller. Rejects (value-free) on a network error or the timeout.
 */
export async function sendRequest(
  fetchFn: FetchLike,
  url: string,
  init: Omit<FetchInit, "signal">,
  timeoutMs: number,
): Promise<HttpResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  const exchange = (async () => {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, body: parseJson(text) };
  })();
  try {
    return await Promise.race([exchange, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `error.status` / `error.message` of a Google API error body, when present. */
export function errorDetail(body: unknown): { status?: string; message?: string } {
  if (typeof body !== "object" || body === null) return {};
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return {};
  const { status, message } = error as { status?: unknown; message?: unknown };
  return {
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

/** HTTP status (and the API's status string) to our code. */
export function codeFor(status: number, apiStatus: string | undefined): FirestoreRestCode {
  if (status === 429 || apiStatus === "RESOURCE_EXHAUSTED") return "resource-exhausted";
  if (status === 408 || status >= 500 || status === 0) return "unavailable";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission-denied";
  if (status === 404) return "not-found";
  if (status === 409 || apiStatus === "ABORTED") return "aborted";
  if (apiStatus === "FAILED_PRECONDITION") return "failed-precondition";
  return "invalid-argument";
}

function retryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Verb = "get" | "runQuery" | "commit" | "delete";

/** Per-call options: `timeoutMs` replaces the payload timeout of every attempt of this call. */
interface CallOptions {
  readonly timeoutMs?: number;
}

export class FirestoreRest {
  readonly #auth: TokenSource;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #root: string;
  readonly #documentsUrl: string;

  constructor(options: FirestoreRestOptions) {
    const { endpoint } = options;
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retries = options.retries ?? DEFAULT_RETRIES;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#root = `projects/${endpoint.projectId}/databases/${endpoint.database ?? "(default)"}/documents`;
    const base = (endpoint.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#documentsUrl = `${base}/v1/${this.#root}`;
  }

  /** "projects/<p>/databases/<db>/documents/<path>" for a relative path ("" is the root). */
  fullName(path: string): string {
    checkPath(path);
    return path === "" ? this.#root : `${this.#root}/${path}`;
  }

  /** The relative path of a full resource name (a relative path passes through). */
  relativeName(fullName: string): string {
    if (fullName === this.#root) return "";
    const prefix = `${this.#root}/`;
    if (fullName.startsWith(prefix)) return fullName.slice(prefix.length);
    if (fullName.startsWith("projects/")) throw new Error("firestore_invalid_id");
    return fullName;
  }

  /**
   * The timeout of a request that moves `payloadBytes` (request body or expected response): the base
   * plus 1 s per 100 KiB, at most 120 s (never below the base).
   */
  timeoutFor(payloadBytes: number): number {
    const extra = Math.floor((Math.max(0, payloadBytes) * 1000) / PAYLOAD_BYTES_PER_SECOND);
    return Math.max(this.#timeoutMs, Math.min(MAX_PAYLOAD_TIMEOUT_MS, this.#timeoutMs + extra));
  }

  /** Relative document path "vaults/<v>/segments/<id>"; undefined on 404. */
  async get(path: string, options: CallOptions = {}): Promise<FsDocument | undefined> {
    checkPath(path);
    if (path === "") throw new Error("firestore_invalid_id");
    try {
      const body = await this.#request("get", "GET", this.#url(path), undefined, options);
      return toDocument(body, "get");
    } catch (e) {
      if (e instanceof FirestoreRestError && e.code === "not-found") return undefined;
      throw e;
    }
  }

  /** `parentPath` "" for the root or a document path; returns documents (never the empty result rows). */
  async runQuery(
    parentPath: string,
    query: FsQuery,
    options: CallOptions = {},
  ): Promise<FsDocument[]> {
    const url = `${parentPath === "" ? this.#documentsUrl : this.#url(parentPath)}:runQuery`;
    const body = await this.#request(
      "runQuery",
      "POST",
      url,
      { structuredQuery: structuredQuery(query) },
      options,
    );
    if (!Array.isArray(body)) throw new FirestoreRestError("unavailable", 0, "runQuery");
    const out: FsDocument[] = [];
    for (const row of body) {
      const document = (row as { document?: unknown } | null)?.document;
      if (document !== undefined) out.push(toDocument(document, "runQuery"));
    }
    return out;
  }

  /** Atomic `:commit`. Resolves with the write results' updateTimes. */
  async commit(
    writes: readonly FsWrite[],
    options: CallOptions = {},
  ): Promise<{ commitTime: string; updateTimes: (string | undefined)[] }> {
    const body = await this.#request(
      "commit",
      "POST",
      `${this.#documentsUrl}:commit`,
      { writes: writes.map((w) => this.#normalizeWrite(w)) },
      options,
    );
    const { commitTime, writeResults } = (body ?? {}) as {
      commitTime?: unknown;
      writeResults?: unknown;
    };
    if (typeof commitTime !== "string") throw new FirestoreRestError("unavailable", 0, "commit");
    const results = Array.isArray(writeResults) ? writeResults : [];
    const updateTimes = writes.map((_, i) => {
      const t = (results[i] as { updateTime?: unknown } | undefined)?.updateTime;
      return typeof t === "string" ? t : undefined;
    });
    return { commitTime, updateTimes };
  }

  async delete(path: string, precondition?: FsPrecondition): Promise<void> {
    checkPath(path);
    if (path === "") throw new Error("firestore_invalid_id");
    let url = this.#url(path);
    if (precondition) {
      url +=
        "exists" in precondition
          ? `?currentDocument.exists=${precondition.exists}`
          : `?currentDocument.updateTime=${encodeURIComponent(precondition.updateTime)}`;
    }
    await this.#request("delete", "DELETE", url);
  }

  #url(path: string): string {
    checkPath(path);
    return `${this.#documentsUrl}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  #normalizeWrite(write: FsWrite): FsWrite {
    if ("delete" in write) return { ...write, delete: this.#absolute(write.delete) };
    return { ...write, update: { ...write.update, name: this.#absolute(write.update.name) } };
  }

  #absolute(name: string): string {
    return name.startsWith("projects/") ? this.#checkedFull(name) : this.fullName(name);
  }

  #checkedFull(name: string): string {
    this.relativeName(name);
    return name;
  }

  async #request(
    verb: Verb,
    method: string,
    url: string,
    payload?: unknown,
    options: CallOptions = {},
  ): Promise<unknown> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const timeoutMs = options.timeoutMs ?? this.timeoutFor(body?.length ?? 0);
    let attempts = 0;
    let reauthorized = false;
    for (;;) {
      const token = await this.#token(verb);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let result: HttpResult;
      try {
        result = await sendRequest(
          this.#fetch,
          url,
          { method, headers, ...(body === undefined ? {} : { body }) },
          timeoutMs,
        );
      } catch {
        result = { status: 0, body: undefined };
      }
      const { status } = result;
      if (status >= 200 && status < 300) return result.body;
      if (status === 401 && !reauthorized && this.#auth.invalidate) {
        reauthorized = true;
        this.#auth.invalidate();
        continue;
      }
      if (retryable(status) && attempts < this.#retries) {
        attempts++;
        await this.#sleep(250 + Math.floor(Math.random() * 500));
        continue;
      }
      throw new FirestoreRestError(codeFor(status, errorDetail(result.body).status), status, verb);
    }
  }

  async #token(verb: Verb): Promise<string> {
    try {
      return await this.#auth.token();
    } catch (e) {
      // Only "the identity server is unreachable or rate limited" keeps its code. Anything else (a
      // refused API key or project, a malformed answer) is `unauthenticated`: it must not read as the
      // database refusing this device (`permission-denied` = revoked).
      if (
        e instanceof FirestoreRestError &&
        (e.code === "unavailable" || e.code === "resource-exhausted")
      ) {
        throw e;
      }
      throw new FirestoreRestError(
        "unauthenticated",
        e instanceof FirestoreRestError ? e.status : 0,
        verb,
      );
    }
  }
}

/** A relative path: segments without "/", never empty, "." or "..". "" is the root. */
function checkPath(path: string): void {
  if (path === "") return;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("firestore_invalid_id");
    }
  }
}

function structuredQuery(query: FsQuery): Record<string, unknown> {
  const out: Record<string, unknown> = { from: [{ collectionId: query.collectionId }] };
  const filters = (query.where ?? []).map((f) => ({
    fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: f.value },
  }));
  if (filters.length === 1) out.where = filters[0];
  else if (filters.length > 1) out.where = { compositeFilter: { op: "AND", filters } };
  if (query.orderBy?.length) {
    out.orderBy = query.orderBy.map((o) => ({
      field: { fieldPath: o.field },
      direction: o.direction ?? "ASCENDING",
    }));
  }
  if (query.select) out.select = { fields: query.select.map((fieldPath) => ({ fieldPath })) };
  if (query.limit !== undefined) out.limit = query.limit;
  return out;
}

function toDocument(raw: unknown, verb: Verb): FsDocument {
  if (typeof raw !== "object" || raw === null) throw new FirestoreRestError("unavailable", 0, verb);
  const { name, fields, createTime, updateTime } = raw as Record<string, unknown>;
  if (typeof name !== "string") throw new FirestoreRestError("unavailable", 0, verb);
  return {
    name,
    fields: (typeof fields === "object" && fields !== null ? fields : {}) as Record<
      string,
      FsValue
    >,
    ...(typeof createTime === "string" ? { createTime } : {}),
    ...(typeof updateTime === "string" ? { updateTime } : {}),
  };
}

// Value helpers.

export function str(value: string): FsValue {
  return { stringValue: value };
}

export function int(value: number): FsValue {
  if (!Number.isSafeInteger(value)) throw new RangeError("firestore integer out of range");
  return { integerValue: String(value) };
}

export function bytes(value: Uint8Array): FsValue {
  return { bytesValue: toBase64(value) };
}

export function ts(iso: string): FsValue {
  return { timestampValue: iso };
}

function badValue(): FirestoreRestError {
  return new FirestoreRestError("invalid-argument", 0, "decode");
}

/** The integer of an `integerValue` (a missing field or another type is a decode error). */
export function readInt(value: FsValue | undefined): number {
  if (!value || !("integerValue" in value)) throw badValue();
  const n = Number(value.integerValue);
  if (!Number.isSafeInteger(n)) throw badValue();
  return n;
}

export function readBytes(value: FsValue | undefined): Uint8Array {
  if (!value || !("bytesValue" in value)) throw badValue();
  try {
    return fromBase64(value.bytesValue);
  } catch {
    throw badValue();
  }
}

export function readStr(value: FsValue | undefined): string {
  if (!value || !("stringValue" in value)) throw badValue();
  return value.stringValue;
}
