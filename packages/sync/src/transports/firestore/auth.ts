// Anonymous Firebase identity over the Identity Toolkit REST API (M4-A): one sign-up per device,
// the refresh token kept by an injected `AuthStore` (the host's keychain, the phone's KeyStore: it is
// a secret), id tokens refreshed through securetoken before they are 50 minutes old.
//
// A refresh the server refuses for good (TOKEN_EXPIRED, USER_NOT_FOUND, INVALID_REFRESH_TOKEN,
// USER_DISABLED) means the identity is lost: the record is cleared, `onIdentityLost` is told the old
// uid and a new anonymous user is signed up. The vault membership belonged to the old uid, so the
// caller must have the Mac grant it again (the transport reports `relay-identity-lost`).
//
// Errors are `FirestoreRestError` with value-free messages; tokens never reach a message or a log.
import type { Awaitable } from "../../carrier.js";
import {
  codeFor,
  errorDetail,
  type FetchLike,
  FirestoreRestError,
  type HttpResult,
  sendRequest,
  type TokenSource,
} from "./rest.js";

export interface AuthRecord {
  readonly uid: string;
  readonly refreshToken: string;
}

export interface AuthStore {
  load(): Awaitable<AuthRecord | undefined>;
  save(record: AuthRecord): Awaitable<void>;
  clear(): Awaitable<void>;
}

export interface IdentityEndpoint {
  readonly apiKey: string;
  /** "https://identitytoolkit.googleapis.com" | emulator "http://127.0.0.1:9099/identitytoolkit.googleapis.com" */
  readonly baseUrl?: string;
  /** "https://securetoken.googleapis.com" | emulator "http://127.0.0.1:9099/securetoken.googleapis.com" */
  readonly tokenBaseUrl?: string;
}

export interface AnonymousAuthOptions {
  endpoint: IdentityEndpoint;
  store: AuthStore;
  /** Default `globalThis.fetch`. */
  fetch?: FetchLike;
  now?: () => number;
  /** Per request, default 10_000. */
  timeoutMs?: number;
  onIdentityLost?: (previousUid: string) => void;
}

const DEFAULT_IDENTITY_URL = "https://identitytoolkit.googleapis.com";
const DEFAULT_TOKEN_URL = "https://securetoken.googleapis.com";
const MAX_TOKEN_AGE_MS = 50 * 60 * 1000;
const IDENTITY_LOST = ["TOKEN_EXPIRED", "USER_NOT_FOUND", "INVALID_REFRESH_TOKEN", "USER_DISABLED"];

interface Session {
  readonly uid: string;
  readonly idToken: string;
  /** `now()` after which the token is refreshed. */
  readonly staleAt: number;
}

export class AnonymousAuth implements TokenSource {
  readonly #endpoint: IdentityEndpoint;
  readonly #store: AuthStore;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #onIdentityLost: ((previousUid: string) => void) | undefined;
  #session: Session | undefined;
  #pending: Promise<Session> | undefined;

  constructor(options: AnonymousAuthOptions) {
    this.#endpoint = options.endpoint;
    this.#store = options.store;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#onIdentityLost = options.onIdentityLost;
  }

  /** A valid id token: cached until 50 min old, refreshed with the stored refresh token, else a new anonymous sign-up (saved). */
  async token(): Promise<string> {
    return (await this.#current()).idToken;
  }

  async uid(): Promise<string> {
    return (await this.#current()).uid;
  }

  /** Drop the cached id token (after a 401). */
  invalidate(): void {
    this.#session = undefined;
  }

  #current(): Promise<Session> {
    const session = this.#session;
    if (session && this.#now() < session.staleAt) return Promise.resolve(session);
    if (!this.#pending) {
      this.#pending = this.#acquire().finally(() => {
        this.#pending = undefined;
      });
    }
    return this.#pending;
  }

  async #acquire(): Promise<Session> {
    const record = await this.#store.load();
    const session = record ? await this.#refreshOrReplace(record) : await this.#signUp();
    this.#session = session;
    return session;
  }

  async #refreshOrReplace(record: AuthRecord): Promise<Session> {
    const startedAt = this.#now();
    const url = `${this.#endpoint.tokenBaseUrl ?? DEFAULT_TOKEN_URL}/v1/token?key=${encodeURIComponent(this.#endpoint.apiKey)}`;
    const form = `grant_type=refresh_token&refresh_token=${encodeURIComponent(record.refreshToken)}`;
    const result = await this.#post("refresh", url, "application/x-www-form-urlencoded", form);
    if (result.status === 400 && isIdentityLost(errorDetail(result.body).message)) {
      await this.#store.clear();
      try {
        this.#onIdentityLost?.(record.uid);
      } catch {
        // The record is already cleared: a throwing listener must not stop the new sign-up (it would
        // happen silently on the next call, without a second report).
      }
      return this.#signUp();
    }
    this.#check(result, "refresh");
    const body = result.body as Record<string, unknown>;
    const { id_token: idToken, refresh_token: refreshToken, user_id: uid } = body;
    if (
      typeof idToken !== "string" ||
      typeof refreshToken !== "string" ||
      typeof uid !== "string"
    ) {
      throw new FirestoreRestError("unavailable", 0, "refresh");
    }
    if (uid !== record.uid || refreshToken !== record.refreshToken) {
      await this.#store.save({ uid, refreshToken });
    }
    return { uid, idToken, staleAt: startedAt + lifetime(body.expires_in) };
  }

  async #signUp(): Promise<Session> {
    const startedAt = this.#now();
    const url = `${this.#endpoint.baseUrl ?? DEFAULT_IDENTITY_URL}/v1/accounts:signUp?key=${encodeURIComponent(this.#endpoint.apiKey)}`;
    const result = await this.#post(
      "signUp",
      url,
      "application/json",
      JSON.stringify({ returnSecureToken: true }),
    );
    this.#check(result, "signUp");
    const body = result.body as Record<string, unknown>;
    const { idToken, refreshToken, localId: uid } = body;
    if (
      typeof idToken !== "string" ||
      typeof refreshToken !== "string" ||
      typeof uid !== "string"
    ) {
      throw new FirestoreRestError("unavailable", 0, "signUp");
    }
    await this.#store.save({ uid, refreshToken });
    return { uid, idToken, staleAt: startedAt + lifetime(body.expiresIn) };
  }

  async #post(verb: string, url: string, contentType: string, body: string): Promise<HttpResult> {
    try {
      return await sendRequest(
        this.#fetch,
        url,
        { method: "POST", headers: { "Content-Type": contentType }, body },
        this.#timeoutMs,
      );
    } catch {
      throw new FirestoreRestError("unavailable", 0, verb);
    }
  }

  #check(result: HttpResult, verb: string): void {
    const ok = result.status >= 200 && result.status < 300;
    if (ok && typeof result.body === "object" && result.body !== null) return;
    const code = ok ? "unavailable" : codeFor(result.status, errorDetail(result.body).status);
    throw new FirestoreRestError(code, result.status, verb);
  }
}

/** Identity Toolkit messages look like "TOKEN_EXPIRED" or "INVALID_REFRESH_TOKEN : detail". */
function isIdentityLost(message: string | undefined): boolean {
  const head = (message ?? "").split(":")[0]?.trim() ?? "";
  return IDENTITY_LOST.includes(head);
}

/** Refresh at 50 minutes, earlier when the server grants a shorter lifetime. */
function lifetime(expiresIn: unknown): number {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return MAX_TOKEN_AGE_MS;
  return Math.min(MAX_TOKEN_AGE_MS, Math.floor((seconds * 1000 * 5) / 6));
}
