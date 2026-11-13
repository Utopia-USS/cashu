// In-memory Firebase for tests (M4-A): the Firestore REST v1 subset the relay transport uses (get,
// runQuery, an atomic commit with preconditions, delete) plus the Identity Toolkit `accounts:signUp`
// and securetoken refresh, served by one `fetch`-compatible function. Hosts are ignored: requests are
// routed by path, so any `baseUrl` works ("http://fake" by default).
//
// What it honours exactly (the transport and its contract tests rely on it): documents keyed by full
// name, RFC 3339 create / update times with microsecond uniqueness per commit, a write that changes
// nothing keeping the previous updateTime (as Firestore does), 404 on a missing document, `runQuery`
// with AND-ed field filters on integer / string values, `orderBy`, `select` (`__name__` = names only,
// an empty projection = every field) and `limit`, refusing (400 FAILED_PRECONDITION, "needs an
// index") a query that would need a composite index; an atomic commit (every precondition checked
// before any write, `updateMask` merges) answering a failed precondition like Firestore: `exists:
// false` on an existing document 409 ALREADY_EXISTS, `exists: true` on a missing one 404 NOT_FOUND,
// an `updateTime` mismatch 400 FAILED_PRECONDITION; the 1 MiB document size (name + fields + 32
// bytes) and 10 MiB request limits, a required parseable `Authorization` header (401 otherwise).
// What it does NOT do: security rules (the emulator tests cover them), listeners, transactions.
import type { AuthRecord, AuthStore, IdentityEndpoint } from "../transports/firestore/auth.js";
import type {
  FetchInit,
  FetchLike,
  FetchResponse,
  FirestoreEndpoint,
  FsDocument,
  FsPrecondition,
  FsValue,
} from "../transports/firestore/rest.js";

export interface FakeFirebaseOptions {
  /** Default "demo-cashu". */
  readonly projectId?: string;
  readonly now?: () => number;
}

export interface FakeFaults {
  /** Fail the next `n` Firestore requests (any verb) with HTTP 503. */
  unavailable(n: number): void;
  /** Delay every request by `ms` (for timeout tests; combine with a short timeoutMs). */
  slow(ms: number): void;
  /** The next commit is applied but the response is lost (HTTP 503 after the write). */
  loseNextCommitResponse(): void;
  /** Fail the next `n` Firestore requests with 429 RESOURCE_EXHAUSTED. */
  quota(n: number): void;
  reset(): void;
}

export interface FakeFirebase {
  /** Serves Firestore REST, Identity Toolkit and securetoken URLs. */
  readonly fetch: FetchLike;
  readonly faults: FakeFaults;
  /** Documents by relative path (a snapshot copy), optionally only those under `prefix`. */
  documents(prefix?: string): ReadonlyMap<string, FsDocument>;
  /** Requests received per verb (live). */
  readonly counters: {
    get: number;
    runQuery: number;
    commit: number;
    delete: number;
    signUp: number;
    refresh: number;
  };
  readonly endpoint: FirestoreEndpoint;
  readonly identity: IdentityEndpoint;
  /** Refuse the user's refresh token from now on (the next refresh answers 400 TOKEN_EXPIRED). */
  expireUser(uid: string): void;
  /** Refuse every id token issued so far (the next Firestore request with one answers 401). */
  expireIdTokens(): void;
  /** Documents, users, counters and faults back to empty. */
  reset(): void;
}

export class MemoryAuthStore implements AuthStore {
  record: AuthRecord | undefined;

  constructor(record?: AuthRecord) {
    this.record = record;
  }

  load(): AuthRecord | undefined {
    return this.record;
  }

  save(record: AuthRecord): void {
    this.record = record;
  }

  clear(): void {
    this.record = undefined;
  }
}

const BASE_URL = "http://fake";
const MAX_DOCUMENT_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_WRITES = 500;
const ID_TOKEN_SECONDS = 3600;

interface StoredDocument {
  fields: Record<string, FsValue>;
  createTime: string;
  updateTime: string;
}

interface Route {
  readonly kind: "get" | "runQuery" | "commit" | "delete" | "signUp" | "refresh" | "none";
  /** Path after ".../documents" when the request is for this fake's project and database. */
  readonly tail?: string | undefined;
}

interface IssuedToken {
  readonly uid: string;
  readonly issuedAt: number;
}

class HttpFailure {
  readonly status: number;
  readonly apiStatus: string;
  readonly message: string;
  constructor(status: number, apiStatus: string, message: string) {
    this.status = status;
    this.apiStatus = apiStatus;
    this.message = message;
  }
}

export function createFakeFirebase(options: FakeFirebaseOptions = {}): FakeFirebase {
  return new Fake(options.projectId ?? "demo-cashu", options.now ?? Date.now);
}

class Fake implements FakeFirebase {
  readonly endpoint: FirestoreEndpoint;
  readonly identity: IdentityEndpoint;
  readonly counters = { get: 0, runQuery: 0, commit: 0, delete: 0, signUp: 0, refresh: 0 };
  readonly faults: FakeFaults;
  readonly fetch: FetchLike;

  readonly #now: () => number;
  readonly #root: string;
  #docs = new Map<string, StoredDocument>();
  /** refresh token -> uid; a deleted entry is an expired user. */
  #refreshTokens = new Map<string, string>();
  #idTokens = new Map<string, IssuedToken>();
  #users = 0;
  #tokens = 0;
  #lastMicros = 0n;
  #unavailable = 0;
  #quota = 0;
  #slowMs = 0;
  #loseCommit = false;

  constructor(projectId: string, now: () => number) {
    this.#now = now;
    this.#root = `projects/${projectId}/databases/(default)/documents`;
    this.endpoint = { projectId, baseUrl: BASE_URL };
    this.identity = {
      apiKey: "fake-api-key",
      baseUrl: `${BASE_URL}/identitytoolkit.googleapis.com`,
      tokenBaseUrl: `${BASE_URL}/securetoken.googleapis.com`,
    };
    this.faults = {
      unavailable: (n) => {
        this.#unavailable = n;
      },
      slow: (ms) => {
        this.#slowMs = ms;
      },
      loseNextCommitResponse: () => {
        this.#loseCommit = true;
      },
      quota: (n) => {
        this.#quota = n;
      },
      reset: () => {
        this.#unavailable = 0;
        this.#quota = 0;
        this.#slowMs = 0;
        this.#loseCommit = false;
      },
    };
    this.fetch = (url, init) => this.#serve(url, init);
  }

  documents(prefix = ""): ReadonlyMap<string, FsDocument> {
    const out = new Map<string, FsDocument>();
    for (const [name, doc] of [...this.#docs.entries()].sort(([a], [b]) => compareStr(a, b))) {
      const relative = name.slice(this.#root.length + 1);
      if (relative.startsWith(prefix)) out.set(relative, this.#render(name, doc));
    }
    return out;
  }

  expireUser(uid: string): void {
    for (const [token, owner] of this.#refreshTokens) {
      if (owner === uid) this.#refreshTokens.delete(token);
    }
  }

  expireIdTokens(): void {
    this.#idTokens.clear();
  }

  reset(): void {
    this.#docs = new Map();
    this.#refreshTokens = new Map();
    this.#idTokens = new Map();
    this.#users = 0;
    this.#tokens = 0;
    for (const key of Object.keys(this.counters) as (keyof Fake["counters"])[]) {
      this.counters[key] = 0;
    }
    this.faults.reset();
  }

  async #serve(url: string, init: FetchInit): Promise<FetchResponse> {
    const parsed = new URL(url);
    const route = this.#routeOf(parsed.pathname, init.method);
    // Counted on receipt, so a request that times out in a `slow` fault still counts.
    if (route.kind !== "none") this.counters[route.kind]++;
    if (this.#slowMs > 0) await delay(this.#slowMs, init.signal);
    if (init.signal?.aborted) throw abortError();
    let status: number;
    let body: unknown;
    try {
      [status, body] = this.#dispatch(route, parsed, init);
    } catch (e) {
      if (!(e instanceof HttpFailure)) throw e;
      status = e.status;
      body = { error: { code: e.status, status: e.apiStatus, message: e.message } };
    }
    const text = body === undefined ? "" : JSON.stringify(body);
    return {
      status,
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
    };
  }

  #routeOf(path: string, method: string): Route {
    if (path.endsWith("/v1/accounts:signUp") && method === "POST") return { kind: "signUp" };
    if (path.endsWith("/v1/token") && method === "POST") return { kind: "refresh" };
    if (!path.startsWith("/v1/projects/")) return { kind: "none" };
    const marker = `/v1/${this.#root}`;
    const tail = path.startsWith(marker) ? path.slice(marker.length) : undefined;
    return { kind: verbOf(tail, method) ?? "none", tail };
  }

  #dispatch(route: Route, url: URL, init: FetchInit): [number, unknown] {
    if (route.kind === "signUp") return this.#signUp(url);
    if (route.kind === "refresh") return this.#refresh(url, init);
    if (!url.pathname.startsWith("/v1/projects/")) {
      throw new HttpFailure(404, "NOT_FOUND", "no route");
    }
    const { tail } = route;
    if (this.#unavailable > 0) {
      this.#unavailable--;
      throw new HttpFailure(503, "UNAVAILABLE", "fault");
    }
    if (this.#quota > 0) {
      this.#quota--;
      throw new HttpFailure(429, "RESOURCE_EXHAUSTED", "fault");
    }
    this.#authorize(init.headers);
    if (tail === undefined) throw new HttpFailure(403, "PERMISSION_DENIED", "other project");
    if ((init.body ?? "").length > MAX_REQUEST_BYTES) {
      throw new HttpFailure(400, "INVALID_ARGUMENT", "request too large");
    }
    switch (route.kind) {
      case "commit": {
        if (this.#loseCommit) {
          this.#loseCommit = false;
          try {
            this.#commit(init.body);
          } catch (e) {
            if (!(e instanceof HttpFailure)) throw e;
          }
          throw new HttpFailure(503, "UNAVAILABLE", "response lost");
        }
        return [200, this.#commit(init.body)];
      }
      case "runQuery":
        return [200, this.#runQuery(tail.slice(0, -":runQuery".length), init.body)];
      case "get":
        return [200, this.#get(tail)];
      case "delete":
        return [200, this.#delete(tail, url.searchParams)];
      default:
        throw new HttpFailure(400, "INVALID_ARGUMENT", "unsupported");
    }
  }

  #authorize(headers: Record<string, string>): void {
    const header = Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
    const match = /^Bearer (fake-id-token:[^:]+:\d+)$/.exec(header ?? "");
    const issued = match?.[1] === undefined ? undefined : this.#idTokens.get(match[1]);
    if (!issued || this.#now() - issued.issuedAt >= ID_TOKEN_SECONDS * 1000) {
      throw new HttpFailure(401, "UNAUTHENTICATED", "missing or invalid token");
    }
  }

  // Identity Toolkit.

  #issue(uid: string): string {
    const token = `fake-id-token:${uid}:${++this.#tokens}`;
    this.#idTokens.set(token, { uid, issuedAt: this.#now() });
    return token;
  }

  #signUp(url: URL): [number, unknown] {
    if (!url.searchParams.get("key")) throw new HttpFailure(400, "INVALID_ARGUMENT", "no key");
    const uid = `fake-${++this.#users}`;
    const refreshToken = `fake-refresh:${uid}`;
    this.#refreshTokens.set(refreshToken, uid);
    return [
      200,
      {
        kind: "identitytoolkit#SignupNewUserResponse",
        idToken: this.#issue(uid),
        refreshToken,
        expiresIn: String(ID_TOKEN_SECONDS),
        localId: uid,
      },
    ];
  }

  #refresh(url: URL, init: FetchInit): [number, unknown] {
    if (!url.searchParams.get("key")) throw new HttpFailure(400, "INVALID_ARGUMENT", "no key");
    const form = new URLSearchParams(init.body ?? "");
    const refreshToken = form.get("refresh_token") ?? "";
    if (form.get("grant_type") !== "refresh_token") {
      throw new HttpFailure(400, "INVALID_ARGUMENT", "INVALID_GRANT_TYPE");
    }
    const uid = this.#refreshTokens.get(refreshToken);
    if (uid === undefined) {
      const known = /^fake-refresh:fake-\d+$/.test(refreshToken);
      throw new HttpFailure(
        400,
        "INVALID_ARGUMENT",
        known ? "TOKEN_EXPIRED" : "INVALID_REFRESH_TOKEN",
      );
    }
    return [
      200,
      {
        id_token: this.#issue(uid),
        refresh_token: refreshToken,
        user_id: uid,
        expires_in: String(ID_TOKEN_SECONDS),
        token_type: "Bearer",
      },
    ];
  }

  // Firestore.

  /** Full name of a document from a URL path tail (percent-encoded) or a raw name tail. */
  #name(tail: string, encoded = true): string {
    let segments = tail.split("/").filter((s) => s !== "");
    if (encoded) {
      try {
        segments = segments.map(decodeURIComponent);
      } catch {
        throw new HttpFailure(400, "INVALID_ARGUMENT", "bad path");
      }
    }
    if (segments.length === 0 || segments.length % 2 !== 0) {
      throw new HttpFailure(400, "INVALID_ARGUMENT", "not a document path");
    }
    return `${this.#root}/${segments.join("/")}`;
  }

  #get(tail: string): unknown {
    const name = this.#name(tail);
    const doc = this.#docs.get(name);
    if (!doc) throw new HttpFailure(404, "NOT_FOUND", "no document");
    return this.#render(name, doc);
  }

  #delete(tail: string, params: URLSearchParams): unknown {
    const name = this.#name(tail);
    const exists = params.get("currentDocument.exists");
    const updateTime = params.get("currentDocument.updateTime");
    const precondition: FsPrecondition | undefined =
      exists !== null
        ? { exists: exists === "true" }
        : updateTime !== null
          ? { updateTime }
          : undefined;
    this.#check(name, precondition, this.#docs);
    this.#docs.delete(name);
    return {};
  }

  #commit(raw: string | undefined): unknown {
    const request = parseBody(raw) as { writes?: unknown };
    const writes = Array.isArray(request.writes) ? request.writes : [];
    if (writes.length > MAX_WRITES)
      throw new HttpFailure(400, "INVALID_ARGUMENT", "too many writes");
    // Preconditions against the state before the commit, every one before any write.
    for (const write of writes) {
      const w = write as {
        update?: { name?: unknown };
        delete?: unknown;
        currentDocument?: unknown;
      };
      const name = this.#ownName(w.update ? w.update.name : w.delete);
      this.#check(name, w.currentDocument as FsPrecondition | undefined, this.#docs);
    }
    const next = new Map(this.#docs);
    const commitTime = this.#tick();
    const writeResults: unknown[] = [];
    for (const write of writes) {
      const w = write as {
        update?: { name: string; fields?: Record<string, FsValue> };
        delete?: string;
        updateMask?: { fieldPaths?: string[] };
      };
      if (w.update) {
        const name = this.#ownName(w.update.name);
        const before = next.get(name);
        const incoming = w.update.fields ?? {};
        let fields: Record<string, FsValue>;
        if (w.updateMask) {
          fields = { ...(before?.fields ?? {}) };
          for (const path of w.updateMask.fieldPaths ?? []) {
            const value = incoming[path];
            if (value === undefined) delete fields[path];
            else fields[path] = value;
          }
        } else {
          fields = { ...incoming };
        }
        if (this.#documentBytes(name, fields) > MAX_DOCUMENT_BYTES) {
          throw new HttpFailure(400, "INVALID_ARGUMENT", "document too large");
        }
        // Firestore: "if the write did not actually change the document", the previous update_time.
        const updateTime =
          before && sameFields(before.fields, fields) ? before.updateTime : commitTime;
        next.set(name, {
          fields: structuredClone(fields),
          createTime: before?.createTime ?? commitTime,
          updateTime,
        });
        writeResults.push({ updateTime });
      } else {
        next.delete(this.#ownName(w.delete));
        writeResults.push({});
      }
    }
    this.#docs = next;
    return { writeResults, commitTime };
  }

  #ownName(name: unknown): string {
    if (typeof name !== "string" || !name.startsWith(`${this.#root}/`)) {
      throw new HttpFailure(400, "INVALID_ARGUMENT", "bad document name");
    }
    return this.#name(name.slice(this.#root.length), false);
  }

  #check(
    name: string,
    precondition: FsPrecondition | undefined,
    docs: ReadonlyMap<string, StoredDocument>,
  ): void {
    if (!precondition) return;
    const doc = docs.get(name);
    if ("exists" in precondition) {
      if (precondition.exists && doc === undefined) {
        throw new HttpFailure(404, "NOT_FOUND", "no document to update");
      }
      if (!precondition.exists && doc !== undefined) {
        throw new HttpFailure(409, "ALREADY_EXISTS", "document already exists");
      }
      return;
    }
    if (doc?.updateTime !== precondition.updateTime) {
      throw new HttpFailure(400, "FAILED_PRECONDITION", "precondition failed");
    }
  }

  /** Firestore's document size: the name (each id + 1, plus 16), the fields and 32 bytes. */
  #documentBytes(name: string, fields: Record<string, FsValue>): number {
    const ids = name.slice(this.#root.length + 1).split("/");
    const nameBytes = ids.reduce((n, id) => n + utf8.encode(id).length + 1, 16);
    return nameBytes + documentSize(fields) + 32;
  }

  #runQuery(parentTail: string, raw: string | undefined): unknown {
    const parent = parentTail === "" ? this.#root : this.#name(parentTail);
    const query = (parseBody(raw) as { structuredQuery?: StructuredQuery }).structuredQuery;
    const collectionId = query?.from?.[0]?.collectionId;
    if (!query || typeof collectionId !== "string" || query.from?.length !== 1) {
      throw new HttpFailure(400, "INVALID_ARGUMENT", "bad query");
    }
    const prefix = `${parent}/${collectionId}/`;
    const filters = flattenFilters(query.where);
    const orderBy = (query.orderBy ?? []).map((o) => ({
      field: o.field?.fieldPath ?? "",
      descending: o.direction === "DESCENDING",
    }));
    if (needsCompositeIndex(filters, orderBy)) {
      throw new HttpFailure(400, "FAILED_PRECONDITION", "the query requires an index");
    }
    let rows = [...this.#docs.entries()].filter(([name, doc]) => {
      if (!name.startsWith(prefix) || name.slice(prefix.length).includes("/")) return false;
      if (!filters.every((f) => matches(doc.fields[f.field], f.op, f.value))) return false;
      return orderBy.every((o) => doc.fields[o.field] !== undefined);
    });
    rows.sort(([an, a], [bn, b]) => {
      for (const o of orderBy) {
        const c = compareValues(a.fields[o.field], b.fields[o.field]) ?? 0;
        if (c !== 0) return o.descending ? -c : c;
      }
      return compareStr(an, bn);
    });
    if (typeof query.limit === "number") rows = rows.slice(0, query.limit);
    const readTime = this.#stamp(this.#lastMicros);
    if (rows.length === 0) return [{ readTime }];
    // An empty projection returns every field (REST `Projection`); `__name__` alone returns none.
    const projected = query.select?.fields?.map((f) => f.fieldPath);
    const select = projected?.length ? projected : undefined;
    return rows.map(([name, doc]) => {
      const fields = select
        ? Object.fromEntries(
            select.flatMap((f) => (doc.fields[f] === undefined ? [] : [[f, doc.fields[f]]])),
          )
        : doc.fields;
      return { document: this.#render(name, { ...doc, fields }), readTime };
    });
  }

  #render(name: string, doc: StoredDocument): FsDocument {
    return {
      name,
      fields: structuredClone(doc.fields),
      createTime: doc.createTime,
      updateTime: doc.updateTime,
    };
  }

  /** A fresh RFC 3339 time with microseconds, strictly after every earlier one. */
  #tick(): string {
    const fromClock = BigInt(Math.floor(this.#now())) * 1000n;
    this.#lastMicros = fromClock > this.#lastMicros ? fromClock : this.#lastMicros + 1n;
    return this.#stamp(this.#lastMicros);
  }

  #stamp(micros: bigint): string {
    const seconds = new Date(Number(micros / 1000n)).toISOString().slice(0, 19);
    return `${seconds}.${String(micros % 1_000_000n).padStart(6, "0")}Z`;
  }
}

type Op = "EQUAL" | "GREATER_THAN" | "GREATER_THAN_OR_EQUAL" | "LESS_THAN";

interface FieldFilterJson {
  field?: { fieldPath?: string };
  op?: string;
  value?: FsValue;
}

interface StructuredQuery {
  from?: { collectionId?: unknown }[];
  where?: { fieldFilter?: FieldFilterJson; compositeFilter?: { op?: string; filters?: unknown[] } };
  orderBy?: { field?: { fieldPath?: string }; direction?: string }[];
  select?: { fields?: { fieldPath: string }[] };
  limit?: unknown;
}

const OPS: readonly string[] = ["EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN"];

function flattenFilters(
  where: StructuredQuery["where"],
): { field: string; op: Op; value: FsValue }[] {
  if (!where) return [];
  const raw: unknown[] = where.compositeFilter
    ? where.compositeFilter.op === "AND"
      ? (where.compositeFilter.filters ?? [])
      : [undefined]
    : [where];
  return raw.map((f) => {
    const ff = (f as { fieldFilter?: FieldFilterJson } | undefined)?.fieldFilter;
    const field = ff?.field?.fieldPath;
    if (!ff || typeof field !== "string" || !OPS.includes(ff.op ?? "") || !ff.value) {
      throw new HttpFailure(400, "INVALID_ARGUMENT", "unsupported filter");
    }
    return { field, op: ff.op as Op, value: ff.value };
  });
}

/**
 * Whether Firestore would need a composite index (none is deployed, so it would refuse the query):
 * filters and orders on more than one field, unless they are equality filters only (single-field
 * indexes merge for those).
 */
function needsCompositeIndex(
  filters: readonly { field: string; op: Op }[],
  orderBy: readonly { field: string }[],
): boolean {
  const fields = new Set([...filters.map((f) => f.field), ...orderBy.map((o) => o.field)]);
  if (fields.size <= 1) return false;
  return orderBy.length > 0 || filters.some((f) => f.op !== "EQUAL");
}

/** Same field names and values (a write with these fields would change nothing). */
function sameFields(a: Record<string, FsValue>, b: Record<string, FsValue>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => b[k] !== undefined && canonical(a[k]) === canonical(b[k]));
}

/** A JSON form independent of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([x], [y]) => compareStr(x, y));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function matches(actual: FsValue | undefined, op: Op, expected: FsValue): boolean {
  const c = compareValues(actual, expected);
  if (c === undefined) return false;
  switch (op) {
    case "EQUAL":
      return c === 0;
    case "GREATER_THAN":
      return c > 0;
    case "GREATER_THAN_OR_EQUAL":
      return c >= 0;
    case "LESS_THAN":
      return c < 0;
  }
}

/** Order of two values of the same kind (integer, string, timestamp); undefined when not comparable. */
function compareValues(a: FsValue | undefined, b: FsValue | undefined): number | undefined {
  if (!a || !b) return undefined;
  if ("integerValue" in a && "integerValue" in b) {
    const x = BigInt(a.integerValue);
    const y = BigInt(b.integerValue);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if ("stringValue" in a && "stringValue" in b) return compareStr(a.stringValue, b.stringValue);
  if ("timestampValue" in a && "timestampValue" in b) {
    return compareStr(a.timestampValue, b.timestampValue);
  }
  return undefined;
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function verbOf(
  tail: string | undefined,
  method: string,
): "get" | "runQuery" | "commit" | "delete" | undefined {
  if (tail === undefined)
    return method === "GET" ? "get" : method === "DELETE" ? "delete" : undefined;
  if (method === "POST" && tail === ":commit") return "commit";
  if (method === "POST" && tail.endsWith(":runQuery")) return "runQuery";
  if (method === "GET") return "get";
  if (method === "DELETE") return "delete";
  return undefined;
}

function parseBody(raw: string | undefined): unknown {
  try {
    const parsed = JSON.parse(raw ?? "") as unknown;
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    // fall through
  }
  throw new HttpFailure(400, "INVALID_ARGUMENT", "bad body");
}

const utf8 = new TextEncoder();

/** Sum of field names and values; a `bytesValue` counts its raw (decoded) length. */
function documentSize(fields: Record<string, FsValue>): number {
  let size = 0;
  for (const [name, value] of Object.entries(fields)) {
    size += utf8.encode(name).length + 1 + valueSize(value);
  }
  return size;
}

function valueSize(value: FsValue): number {
  if ("stringValue" in value) return utf8.encode(value.stringValue).length + 1;
  if ("bytesValue" in value) {
    const b64 = value.bytesValue;
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - padding;
  }
  if ("integerValue" in value || "timestampValue" in value) return 8;
  if ("arrayValue" in value)
    return (value.arrayValue.values ?? []).reduce((n, v) => n + valueSize(v), 0);
  if ("mapValue" in value) return documentSize(value.mapValue.fields ?? {});
  return 1;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}
