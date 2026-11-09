import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";

const API_ORIGIN = "https://api.enablebanking.com";
const body = z.record(z.string(), z.unknown());
const responseLimit = 4 * 1024 * 1024;
const endpoint = /^\/[a-z0-9/_-]+$/;

type BankingFaultKind =
  | "configuration"
  | "transport"
  | "authorization"
  | "expired"
  | "rate_limited"
  /** The local consent callback (127.0.0.1, the redirect URL's port) could not start, e.g. port in use. */
  | "callback"
  /** Enable Banking: the application does not list cashU's redirect URL (REDIRECT_URI_NOT_ALLOWED). */
  | "redirect_not_allowed"
  /** Enable Banking: no bank of that name (WRONG_ASPSP_PROVIDED). */
  | "unknown_bank"
  /** Enable Banking: the restricted application has no linked accounts yet (NO_ACCOUNTS_ADDED). */
  | "app_restricted"
  | "response";

/** Enable Banking error codes that name an application setup problem, and the fault each one is. */
const SETUP_FAULTS: Readonly<Record<string, BankingFaultKind>> = {
  REDIRECT_URI_NOT_ALLOWED: "redirect_not_allowed",
  WRONG_ASPSP_PROVIDED: "unknown_bank",
  NO_ACCOUNTS_ADDED: "app_restricted",
};

/** The `error` code of an Enable Banking error body (an upper-case enum value), or null. */
function enableBankingErrorCode(text: string): string | null {
  if (!text || Buffer.byteLength(text) > 64 * 1024) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const code =
      typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown }).error : null;
    return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

export class BankingFault extends Error {
  readonly kind: BankingFaultKind;
  constructor(kind: BankingFaultKind) {
    super(`enable_banking_${kind}`);
    this.kind = kind;
  }
}

export interface BankingTransport {
  send(input: {
    method: "GET" | "POST" | "DELETE";
    url: URL;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; text: string; retryAfter?: string | null }>;
}

/** Fetch is deliberately exact-origin, no redirect and bounded before JSON decoding. */
export const productionBankingTransport: BankingTransport = {
  async send(input) {
    if (input.url.origin !== API_ORIGIN) throw new BankingFault("configuration");
    let response: Response;
    try {
      response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new BankingFault("transport");
    }
    if (Number(response.headers.get("content-length")) > responseLimit) {
      await response.body?.cancel().catch(() => undefined);
      throw new BankingFault("response");
    }
    if (!response.body)
      return { status: response.status, text: "", retryAfter: response.headers.get("retry-after") };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > responseLimit) throw new BankingFault("response");
        chunks.push(next.value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new BankingFault("response");
    } finally {
      reader.releaseLock();
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new BankingFault("response");
    }
    return { status: response.status, text, retryAfter: response.headers.get("retry-after") };
  },
};

export interface BankingCredentials {
  readonly appId: string;
  readonly privateKeyPem: string;
}
export interface BankingClock {
  now(): Date;
}

function token(credentials: BankingCredentials, now: Date): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(credentials.appId)) throw new BankingFault("configuration");
  const seconds = Math.floor(now.getTime() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "RS256", typ: "JWT", kid: credentials.appId });
  const claim = encode({
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: seconds,
    exp: seconds + 3600,
  });
  try {
    const key = createPrivateKey(credentials.privateKeyPem);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new Error("key");
    return `${head}.${claim}.${sign("RSA-SHA256", Buffer.from(`${head}.${claim}`), key).toString("base64url")}`;
  } catch {
    throw new BankingFault("configuration");
  }
}

export class EnableBankingClient {
  private readonly credentials: BankingCredentials;
  private readonly transport: BankingTransport;
  private readonly clock: BankingClock;
  private readonly origin: string;
  constructor(
    credentials: BankingCredentials,
    transport: BankingTransport,
    clock: BankingClock,
    origin = API_ORIGIN,
  ) {
    this.credentials = credentials;
    this.transport = transport;
    this.clock = clock;
    this.origin = origin;
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new BankingFault("configuration");
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    payload?: object,
    params?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    if (!endpoint.test(path) || path.includes("..")) throw new BankingFault("configuration");
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new BankingFault("configuration");
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    let result: Awaited<ReturnType<BankingTransport["send"]>>;
    try {
      result = await this.transport.send({
        method,
        url,
        headers: {
          Authorization: `Bearer ${token(this.credentials, this.clock.now())}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch (error) {
      if (error instanceof BankingFault) throw error;
      throw new BankingFault("transport");
    }
    // A few of Enable Banking's own error codes say exactly what the owner must fix in their
    // application; read only that code (never the message), the rest keep their HTTP meaning.
    if (result.status >= 400 && result.status !== 429) {
      const setup = SETUP_FAULTS[enableBankingErrorCode(result.text) ?? ""];
      if (setup) throw new BankingFault(setup);
    }
    if (result.status === 401 || result.status === 403) throw new BankingFault("authorization");
    if (result.status === 404 || result.status === 410) throw new BankingFault("expired");
    if (result.status === 429) throw new BankingFault("rate_limited");
    if (
      result.status < 200 ||
      result.status >= 300 ||
      Buffer.byteLength(result.text) > responseLimit
    )
      throw new BankingFault("response");
    if (!result.text) return {};
    try {
      return body.parse(JSON.parse(result.text));
    } catch {
      throw new BankingFault("response");
    }
  }

  application() {
    return this.request("GET", "/application");
  }
  async banks(country: string): Promise<readonly Record<string, unknown>[]> {
    if (!/^[A-Z]{2}$/.test(country)) throw new BankingFault("configuration");
    const result = await this.request("GET", "/aspsps", undefined, { country });
    return parseRecords(result.aspsps);
  }
  authorize(input: {
    aspsp: string;
    country: string;
    validDays: number;
    state: string;
    redirectUrl: string;
  }) {
    if (
      !input.aspsp.trim() ||
      !/^[A-Z]{2}$/.test(input.country) ||
      !Number.isInteger(input.validDays) ||
      input.validDays < 1 ||
      input.validDays > 90 ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(input.state)
    )
      throw new BankingFault("configuration");
    const validUntil = new Date(
      this.clock.now().getTime() + input.validDays * 86_400_000,
    ).toISOString();
    return this.request("POST", "/auth", {
      access: { valid_until: validUntil },
      aspsp: { name: input.aspsp, country: input.country },
      state: input.state,
      redirect_url: input.redirectUrl,
      psu_type: "personal",
    });
  }
  createSession(code: string) {
    if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(code)) throw new BankingFault("authorization");
    return this.request("POST", "/sessions", { code });
  }
  session(id: string) {
    return this.request("GET", `/sessions/${safeId(id)}`);
  }
  accountDetails(uid: string) {
    return this.request("GET", `/accounts/${safeId(uid)}/details`);
  }
  async balances(uid: string): Promise<readonly Record<string, unknown>[]> {
    const result = await this.request("GET", `/accounts/${safeId(uid)}/balances`);
    return parseRecords(result.balances);
  }
  async transactions(
    uid: string,
    from: string,
    to: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let continuation: string | undefined;
    let totalBytes = 0;
    for (let page = 0; page < 1000; page++) {
      const data = await this.request("GET", `/accounts/${safeId(uid)}/transactions`, undefined, {
        date_from: from,
        date_to: to,
        ...(continuation ? { continuation_key: continuation } : {}),
      });
      totalBytes += Buffer.byteLength(JSON.stringify(data));
      if (totalBytes > 16 * 1024 * 1024) throw new BankingFault("response");
      result.push(...parseRecords(data.transactions));
      if (result.length > 100_000) throw new BankingFault("response");
      const next = data.continuation_key;
      if (next == null || next === "") return result;
      if (typeof next !== "string" || next.length > 4096 || seen.has(next))
        throw new BankingFault("response");
      seen.add(next);
      continuation = next;
    }
    throw new BankingFault("response");
  }
}

function parseRecords(value: unknown): Record<string, unknown>[] {
  try {
    return z.array(body).max(100_000).parse(value);
  } catch {
    throw new BankingFault("response");
  }
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._~-]{1,256}$/.test(value)) throw new BankingFault("response");
  return value;
}
