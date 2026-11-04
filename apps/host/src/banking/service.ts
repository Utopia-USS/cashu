import { createHash, createPrivateKey, randomBytes } from "node:crypto";
import { core } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import type { BankingSecretStore } from "@cashu/node-host/banking-secrets";
import { z } from "zod";
import {
  type CallbackCapture,
  listenForBankingCallback,
  parseBankingCallbackUrl,
} from "./callback.js";
import {
  type BankingClock,
  BankingFault,
  type BankingTransport,
  EnableBankingClient,
  productionBankingTransport,
} from "./client.js";
import { accountDetails, accountType, pickBalance, transactionToRaw } from "./normalize.js";

const sessionShape = z.object({
  id: z.string().min(1).max(256),
  institution: z.string().min(1).max(64),
  savedAt: z.string(),
  credentialRevision: z.string(),
  lastSyncAt: z.string().nullable(),
  backoffUntil: z.string().nullable(),
});
type SavedSession = z.infer<typeof sessionShape>;
const sessionsShape = z.array(sessionShape).max(32);
const credentialsShape = z.object({
  appId: z.string(),
  privateKeyPem: z.string(),
  revision: z.string(),
});
type Credentials = z.infer<typeof credentialsShape>;

const queues = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();
const activeSyncs = new Set<string>();
function bump(key: string): void {
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
}
function revision(key: string): number {
  return revisions.get(key) ?? 0;
}
async function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => next);
  queues.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

export interface BankingAuthority {
  readonly profileId: string;
  isCurrent(): boolean;
  isHolder(): boolean;
  isOwnerAction(): boolean;
}
interface BankingStatement {
  readonly bank: string;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
  readonly currency: string;
  readonly transactions: readonly RawTransaction[];
  readonly balances: readonly [];
  readonly closingBalances: readonly { date: string; amount: RawTransaction["amount"] }[];
}
type ImportOutcome =
  | { readonly ok: true; readonly account: string; readonly numInserted: number }
  | { readonly ok: false; readonly reason: string; readonly attempt?: BankingAttempt };
export interface BankingAttempt {
  readonly key: string;
  readonly command: "banking.importAccount";
}
export interface BankingImportPort {
  runImport(input: {
    readonly profileId: string;
    readonly accountGid?: string;
    readonly statement: BankingStatement;
    readonly accountType: "checking" | "savings" | "credit";
    readonly externalId: string;
    readonly guard: () => boolean;
  }): Promise<ImportOutcome>;
  /** Profile-local account lookup, never across vaults. */
  findAccount(
    profileId: string,
    bank: string,
    uid: string,
    iban: string | null,
  ): Promise<{ gid: string; bank: string } | null>;
  checkAttempt(key: string): "completed" | "refused" | "not_started" | "outcome_unknown";
  unresolvedAttempts(): Promise<readonly BankingAttempt[]>;
}
export interface BankingServiceOptions {
  readonly authority: BankingAuthority;
  readonly secrets: BankingSecretStore;
  readonly imports: BankingImportPort;
  readonly redirectUrl: string;
  readonly clock?: BankingClock;
  readonly transport?: BankingTransport;
  readonly apiOrigin?: string;
  readonly callback?: typeof listenForBankingCallback;
  readonly language?: () => "pl" | "en";
}

function iso(date: Date): string {
  return date.toISOString();
}
function day(date: Date): string {
  return iso(date).slice(0, 10);
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function sessionHandle(namespace: string, item: SavedSession): string {
  return createHash("sha256").update(`${namespace}\0${item.id}\0${item.savedAt}`).digest("hex");
}

/** Host-owned, profile-scoped bank service. No session id or private key enters the event log. */
export class EnableBankingService {
  private readonly clock: BankingClock;
  private readonly transport: BankingTransport;
  private readonly callback: typeof listenForBankingCallback;
  private capture: CallbackCapture | null = null;
  private beginGeneration = 0;
  private beginning = false;
  private readonly unknownAttempts = new Map<string, BankingAttempt>();
  private pending: {
    state: string;
    credential: Credentials;
    credentialTick: number;
    bank: string | null;
    keepOthers: boolean;
    days: number;
    url: string;
  } | null = null;

  private readonly options: BankingServiceOptions;
  constructor(options: BankingServiceOptions) {
    this.options = options;
    this.clock = options.clock ?? { now: () => new Date() };
    this.transport = options.transport ?? productionBankingTransport;
    this.callback = options.callback ?? listenForBankingCallback;
  }

  /** Host shutdown or profile removal closes an outstanding local callback listener. */
  async close(): Promise<void> {
    this.beginGeneration++;
    this.beginning = false;
    const capture = this.capture;
    this.capture = null;
    this.pending = null;
    if (capture) await capture.close();
  }

  private guard(holder = false, owner = false): void {
    if (
      !this.options.authority.isCurrent() ||
      (holder && !this.options.authority.isHolder()) ||
      (owner && !this.options.authority.isOwnerAction())
    )
      throw new BankingFault("authorization");
  }
  private async credentials(): Promise<Credentials | null> {
    this.guard();
    const stored = await this.options.secrets.get("credentials");
    this.guard();
    if (!stored) return null;
    try {
      return credentialsShape.parse(JSON.parse(stored));
    } catch {
      throw new BankingFault("configuration");
    }
  }
  private async client(): Promise<EnableBankingClient> {
    const credentials = await this.credentials();
    if (!credentials) throw new BankingFault("configuration");
    return this.clientFor(credentials);
  }
  private clientFor(credentials: Credentials): EnableBankingClient {
    return new EnableBankingClient(credentials, this.transport, this.clock, this.options.apiOrigin);
  }
  private async sessions(): Promise<SavedSession[]> {
    this.guard();
    const value = await this.options.secrets.get("sessions");
    this.guard();
    if (!value) return [];
    try {
      return sessionsShape.parse(JSON.parse(value));
    } catch {
      throw new BankingFault("response");
    }
  }
  private async save(sessions: readonly SavedSession[]): Promise<void> {
    this.guard();
    await this.options.secrets.set("sessions", JSON.stringify(sessionsShape.parse(sessions)));
    this.guard();
  }

  /** Key configuration is an owner-only action. The PEM is never echoed in a result. */
  async configure(input: { appId: string; privateKeyPem: string }): Promise<{ configured: true }> {
    this.guard(false, true);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.appId)) throw new BankingFault("configuration");
    try {
      const key = createPrivateKey(input.privateKeyPem);
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
        throw new Error("invalid key");
    } catch {
      throw new BankingFault("configuration");
    }
    await this.close();
    return serial(this.options.secrets.namespace, async () => {
      this.guard(false, true);
      const credentials = { ...input, revision: randomBytes(16).toString("hex") };
      bump(`${this.options.secrets.namespace}:credentials`);
      await this.options.secrets.set("credentials", JSON.stringify(credentials));
      await this.save([]);
      this.guard(false, true);
      return { configured: true };
    });
  }
  async status() {
    this.guard();
    return serial(this.options.secrets.namespace, async () => {
      const credential = await this.credentials();
      const configured = Boolean(credential);
      const sessions = (await this.sessions())
        .filter((item) => item.credentialRevision === credential?.revision)
        .map((item) => ({
          handle: sessionHandle(this.options.secrets.namespace, item),
          institution: item.institution,
          savedAt: item.savedAt,
          lastSyncAt: item.lastSyncAt,
          backoffUntil: item.backoffUntil,
        }));
      const owner = this.options.authority.isOwnerAction();
      const journalAttempts = owner ? await this.options.imports.unresolvedAttempts() : [];
      this.guard();
      const pendingAttempts = [
        ...new Map(
          [...this.unknownAttempts.values(), ...journalAttempts].map((item) => [item.key, item]),
        ).values(),
      ].slice(0, 100);
      return {
        configured,
        sessions,
        pendingConsent: owner ? (this.pending?.url ?? null) : null,
        pendingAttempts: owner ? pendingAttempts : [],
      };
    });
  }
  async check() {
    this.guard(false, true);
    const info = await (await this.client()).application();
    this.guard(false, true);
    return { ok: true as const, application: { name: text(info.name) } };
  }
  async banks(country = "PL") {
    this.guard(false, true);
    const entries = await (await this.client()).banks(country);
    this.guard(false, true);
    const registry = core.builtinRegistry().institutions;
    return entries.map((entry) => ({
      name: text(entry.name) ?? "",
      country: text(entry.country) ?? country,
      institution: registry.bankFromAspsp(text(entry.name)),
    }));
  }

  async beginConsent(input: {
    aspsp: string;
    country?: string;
    days?: number;
    bank?: string | null;
    keepOthers?: boolean;
  }) {
    this.guard(true, true);
    if (this.pending || this.beginning) throw new BankingFault("authorization");
    this.beginning = true;
    const generation = ++this.beginGeneration;
    const state = randomBytes(32).toString("base64url");
    const days = input.days ?? 90;
    try {
      const snapshot = await serial(this.options.secrets.namespace, async () => {
        const credential = await this.credentials();
        if (!credential) throw new BankingFault("configuration");
        return { credential, tick: revision(`${this.options.secrets.namespace}:credentials`) };
      });
      const capture = await this.callback(
        this.options.redirectUrl,
        state,
        this.options.language?.() ?? "en",
      );
      if (generation !== this.beginGeneration) {
        await capture.close();
        throw new BankingFault("authorization");
      }
      this.capture = capture;
      try {
        const response = await this.clientFor(snapshot.credential).authorize({
          aspsp: input.aspsp,
          country: input.country ?? "PL",
          validDays: days,
          state,
          redirectUrl: capture.redirectUrl,
        });
        this.guard(true, true);
        if (generation !== this.beginGeneration || this.capture !== capture)
          throw new BankingFault("authorization");
        if (revision(`${this.options.secrets.namespace}:credentials`) !== snapshot.tick)
          throw new BankingFault("authorization");
        const url = text(response.url);
        if (!url) throw new BankingFault("response");
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password)
          throw new BankingFault("response");
        this.pending = {
          state,
          credential: snapshot.credential,
          credentialTick: snapshot.tick,
          bank: input.bank ?? null,
          keepOthers: input.keepOthers ?? false,
          days,
          url,
        };
        return { url };
      } catch (error) {
        if (this.capture === capture) this.capture = null;
        await capture.close();
        throw error;
      }
    } finally {
      if (generation === this.beginGeneration) this.beginning = false;
    }
  }

  async completeConsent(callbackUrl?: string): Promise<{
    institution: string;
    accounts: number;
    inserted: number;
    errors: readonly string[];
    attempts: readonly BankingAttempt[];
  }> {
    this.guard(true, true);
    const pending = this.pending;
    const capture = this.capture;
    if (!pending || !capture) throw new BankingFault("authorization");
    this.pending = null;
    this.capture = null;
    let code: string;
    try {
      code =
        callbackUrl === undefined
          ? await capture.wait()
          : parseBankingCallbackUrl(callbackUrl, capture.redirectUrl, pending.state);
    } finally {
      await capture.close();
    }
    this.guard(true, true);
    const credential = pending.credential;
    const credentialTick = pending.credentialTick;
    if (revision(`${this.options.secrets.namespace}:credentials`) !== credentialTick)
      throw new BankingFault("authorization");
    const client = this.clientFor(credential);
    const session = await client.createSession(code);
    const id = text(session.session_id);
    if (!id) throw new BankingFault("response");
    const sameCredential = () =>
      revision(`${this.options.secrets.namespace}:credentials`) === credentialTick;
    const result = await this.syncOne(client, id, pending.bank, pending.days, sameCredential);
    for (const attempt of result.attempts) this.unknownAttempts.set(attempt.key, attempt);
    const institution = result.institution;
    await serial(this.options.secrets.namespace, async () => {
      this.guard(true, true);
      if (!sameCredential() || (await this.credentials())?.revision !== credential.revision)
        throw new BankingFault("authorization");
      const old = await this.sessions();
      const entries = old.filter(
        (item) => item.id !== id && (pending.keepOthers || item.institution !== institution),
      );
      for (const item of old) {
        if (!pending.keepOthers && item.institution === institution)
          bump(`${this.options.secrets.namespace}:session:${item.id}`);
      }
      entries.push({
        id,
        institution,
        credentialRevision: credential.revision,
        savedAt: iso(this.clock.now()),
        lastSyncAt: iso(this.clock.now()),
        backoffUntil: result.errors.includes("rate_limited")
          ? iso(new Date(this.clock.now().getTime() + 20 * 3_600_000))
          : null,
      });
      await this.save(entries);
    });
    return {
      institution,
      accounts: result.accounts,
      inserted: result.inserted,
      errors: result.errors,
      attempts: result.attempts,
    };
  }

  /** Python-style local forget. It does not call an Enable Banking revoke endpoint. */
  async forgetSession(handle: string): Promise<void> {
    this.guard(false, true);
    await serial(this.options.secrets.namespace, async () => {
      const current = await this.sessions();
      const target = current.find(
        (item) => sessionHandle(this.options.secrets.namespace, item) === handle,
      );
      if (!target) throw new BankingFault("response");
      bump(`${this.options.secrets.namespace}:session:${target.id}`);
      await this.save(current.filter((item) => item !== target));
    });
  }

  async cancelConsent(): Promise<void> {
    this.guard(false, true);
    await this.close();
  }

  async sync(input: { days?: number; reason: "manual" | "daily"; guard?: () => void }): Promise<{
    accounts: number;
    banks: number;
    inserted: number;
    errors: readonly string[];
    attempts: readonly BankingAttempt[];
  }> {
    this.guard(true, input.reason === "manual");
    input.guard?.();
    const unresolved = await this.options.imports.unresolvedAttempts();
    this.guard(true, input.reason === "manual");
    input.guard?.();
    if (unresolved.length > 0)
      return {
        accounts: 0,
        banks: 0,
        inserted: 0,
        errors: ["outcome_unknown"],
        attempts: unresolved,
      };
    const snapshot = await serial(this.options.secrets.namespace, async () => {
      this.guard(true, input.reason === "manual");
      input.guard?.();
      const credential = await this.credentials();
      if (!credential) throw new BankingFault("configuration");
      const saved = await this.sessions();
      const credentialTick = revision(`${this.options.secrets.namespace}:credentials`);
      const sessionTicks = new Map(
        saved.map((item) => [
          item.id,
          revision(`${this.options.secrets.namespace}:session:${item.id}`),
        ]),
      );
      return { credential, saved, credentialTick, sessionTicks };
    });
    const { credential, saved, credentialTick, sessionTicks } = snapshot;
    const client = this.clientFor(credential);
    const now = this.clock.now().getTime();
    const updated = new Map<string, SavedSession>();
    const errors: string[] = [];
    const attempts: BankingAttempt[] = [];
    let accounts = 0;
    let banks = 0;
    let inserted = 0;
    for (const item of saved) {
      this.guard(true, input.reason === "manual");
      if (
        item.credentialRevision !== credential.revision ||
        revision(`${this.options.secrets.namespace}:credentials`) !== credentialTick
      )
        continue;
      const sessionKey = `${this.options.secrets.namespace}:session:${item.id}`;
      const sessionTick = sessionTicks.get(item.id) ?? -1;
      const stillCurrent = () =>
        revision(sessionKey) === sessionTick &&
        revision(`${this.options.secrets.namespace}:credentials`) === credentialTick &&
        (() => {
          try {
            input.guard?.();
            return true;
          } catch {
            return false;
          }
        })();
      if (
        (item.backoffUntil && Date.parse(item.backoffUntil) > now) ||
        (input.reason === "daily" &&
          item.lastSyncAt &&
          now - Date.parse(item.lastSyncAt) < 20 * 3_600_000)
      )
        continue;
      if (activeSyncs.has(sessionKey)) continue;
      activeSyncs.add(sessionKey);
      try {
        const result = await this.syncOne(
          client,
          item.id,
          item.institution,
          input.days ?? 90,
          stillCurrent,
        );
        accounts += result.accounts;
        if (result.accounts > 0) banks++;
        inserted += result.inserted;
        errors.push(...result.errors);
        attempts.push(...result.attempts);
        for (const attempt of result.attempts) this.unknownAttempts.set(attempt.key, attempt);
        updated.set(item.id, {
          ...item,
          lastSyncAt: iso(this.clock.now()),
          backoffUntil: result.errors.includes("rate_limited")
            ? iso(new Date(this.clock.now().getTime() + 20 * 3_600_000))
            : null,
        });
      } catch (error) {
        const kind = error instanceof BankingFault ? error.kind : "response";
        errors.push(kind);
        if (kind === "rate_limited")
          updated.set(item.id, { ...item, backoffUntil: iso(new Date(now + 20 * 3_600_000)) });
        if (kind === "expired" || kind === "authorization")
          updated.set(item.id, { ...item, backoffUntil: iso(new Date(now + 24 * 3_600_000)) });
      } finally {
        activeSyncs.delete(sessionKey);
      }
    }
    await serial(this.options.secrets.namespace, async () => {
      if (
        revision(`${this.options.secrets.namespace}:credentials`) !== credentialTick ||
        (await this.credentials())?.revision !== credential.revision
      )
        return;
      const latest = await this.sessions();
      await this.save(
        latest.map((item) => {
          const snapshot = saved.find((old) => old.id === item.id);
          const candidate = updated.get(item.id);
          return snapshot &&
            candidate &&
            snapshot.savedAt === item.savedAt &&
            snapshot.credentialRevision === item.credentialRevision &&
            revision(`${this.options.secrets.namespace}:session:${item.id}`) ===
              (sessionTicks.get(item.id) ?? -1)
            ? candidate
            : item;
        }),
      );
    });
    return { accounts, banks, inserted, errors, attempts };
  }

  attemptStatus(key: string) {
    this.guard(false, true);
    if (!/^[a-f0-9]{32}$/.test(key)) throw new BankingFault("response");
    const status = this.options.imports.checkAttempt(key);
    if (status !== "outcome_unknown") this.unknownAttempts.delete(key);
    return status;
  }

  private async syncOne(
    client: EnableBankingClient,
    id: string,
    bank: string | null,
    days: number,
    stillCurrent: () => boolean = () => true,
  ) {
    this.guard(true);
    if (!stillCurrent()) throw new BankingFault("authorization");
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new BankingFault("configuration");
    const session = await client.session(id);
    this.guard(true);
    if (!stillCurrent()) throw new BankingFault("authorization");
    const status = text(session.status);
    if (status && status !== "AUTHORIZED") {
      if (["EXPIRED", "REVOKED", "CLOSED", "CANCELLED"].includes(status))
        throw new BankingFault("expired");
      throw new BankingFault("authorization");
    }
    const validUntil = text(asRecord(session.access).valid_until);
    if (validUntil) {
      const expiresAt = Date.parse(validUntil);
      if (!Number.isFinite(expiresAt)) throw new BankingFault("response");
      if (expiresAt <= this.clock.now().getTime()) throw new BankingFault("expired");
    }
    const mapped =
      bank ?? core.builtinRegistry().institutions.bankFromAspsp(text(asRecord(session.aspsp).name));
    if (!mapped) throw new BankingFault("response");
    const today = day(this.clock.now());
    const from = day(new Date(this.clock.now().getTime() - days * 86_400_000));
    let accounts = 0;
    let inserted = 0;
    const errors: string[] = [];
    const attempts: BankingAttempt[] = [];
    let entries: (string | Record<string, unknown>)[];
    try {
      entries = z
        .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
        .max(100)
        .parse(session.accounts);
    } catch {
      throw new BankingFault("response");
    }
    for (const entry of entries) {
      this.guard(true);
      if (!stillCurrent()) throw new BankingFault("authorization");
      const embedded = typeof entry === "string" ? {} : entry;
      const uid = typeof entry === "string" ? entry : (text(entry.uid) ?? text(entry.account_uid));
      if (!uid) {
        errors.push("account_missing_uid");
        continue;
      }
      try {
        const hasDetails =
          /^[A-Z]{3}$/.test(text(embedded.currency) ?? "") &&
          (Boolean(asRecord(embedded.account_id).iban) ||
            Boolean(text(embedded.iban)) ||
            Boolean(text(embedded.name)) ||
            Boolean(text(embedded.product)));
        const details = hasDetails ? embedded : await client.accountDetails(uid);
        const txns = await client.transactions(uid, from, today);
        const balances = await client.balances(uid);
        this.guard(true);
        if (!stillCurrent()) throw new BankingFault("authorization");
        const account = accountDetails(details);
        if (!account.currency || !/^[A-Z]{3}$/.test(account.currency))
          throw new BankingFault("response");
        const existing = await this.options.imports.findAccount(
          this.options.authority.profileId,
          mapped,
          uid,
          account.iban,
        );
        this.guard(true);
        const picked = pickBalance(balances, today, account.currency);
        const statement: BankingStatement = {
          bank: existing?.bank ?? mapped,
          accountNumber: account.iban,
          accountName: account.name,
          currency: account.currency,
          transactions: txns
            .map(transactionToRaw)
            .filter((row): row is RawTransaction => row !== null),
          balances: [],
          closingBalances: picked ? [picked] : [],
        };
        const outcome = await this.options.imports.runImport({
          profileId: this.options.authority.profileId,
          accountGid: existing?.gid,
          statement,
          accountType: accountType(details),
          externalId: uid,
          guard: () =>
            this.options.authority.isCurrent() &&
            this.options.authority.isHolder() &&
            stillCurrent(),
        });
        if (!outcome.ok) {
          if (outcome.attempt) attempts.push(outcome.attempt);
          errors.push(outcome.attempt ? "outcome_unknown" : "import_failed");
          continue;
        }
        accounts++;
        inserted += outcome.numInserted;
      } catch (error) {
        errors.push(error instanceof BankingFault ? error.kind : "account_failed");
      }
    }
    return { institution: mapped, accounts, inserted, errors, attempts };
  }
}
