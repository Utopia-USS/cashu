import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { BankingFault, type BankingTransport } from "./client.js";
import { type BankingImportPort, EnableBankingService } from "./service.js";

const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

it("stores only profile-private consent, imports exact decimal rows, and guards final queue entry", async () => {
  const secrets = new Map<string, string>([
    ["credentials", JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })],
  ]);
  let current = true;
  let holder = true;
  let owner = true;
  let limited = false;
  let consentState = "";
  let imports = 0;
  let exposeAttempt = true;
  const calls: string[] = [];
  const transport: BankingTransport = {
    async send(input) {
      calls.push(input.url.pathname);
      const path = input.url.pathname;
      if (limited && path === "/accounts/synthetic-uid/balances")
        return { status: 429, text: "synthetic private error" };
      const response =
        path === "/auth"
          ? { url: "https://synthetic-bank.example/consent" }
          : path === "/sessions" && input.method === "POST"
            ? { session_id: "synthetic-session" }
            : path === "/sessions/synthetic-session"
              ? { aspsp: { name: "mBank" }, accounts: ["synthetic-uid"] }
              : path === "/accounts/synthetic-uid/details"
                ? {
                    account_id: { iban: "PL00000000000000000000000000" },
                    currency: "PLN",
                    name: "Synthetic account",
                  }
                : path === "/accounts/synthetic-uid/transactions"
                  ? {
                      transactions: [
                        {
                          transaction_amount: { amount: "12.340", currency: "PLN" },
                          credit_debit_indicator: "DBIT",
                          booking_date: "2026-11-04",
                          note: "Synthetic",
                          entry_reference: "opaque",
                        },
                      ],
                    }
                  : path === "/accounts/synthetic-uid/balances"
                    ? {
                        balances: [
                          {
                            balance_type: "CLBD",
                            balance_amount: { amount: "100.230", currency: "PLN" },
                            reference_date: "2026-11-04",
                          },
                        ],
                      }
                    : {};
      return { status: 200, text: JSON.stringify(response) };
    },
  };
  const imported: BankingImportPort = {
    checkAttempt: () => "not_started",
    unresolvedAttempts: async () =>
      exposeAttempt ? [{ key: "a".repeat(32), command: "banking.importAccount" }] : [],
    async findAccount(profileId) {
      expect(profileId).toBe("profile-a");
      return null;
    },
    async runImport(input) {
      imports++;
      expect(input.profileId).toBe("profile-a");
      expect(input.statement.transactions[0]?.amount.toString()).toBe("-12.340");
      expect(input.statement.closingBalances[0]?.amount.toString()).toBe("100.230");
      expect(input.statement.transactions[0]?.reference).toBe("Synthetic");
      expect(input.guard()).toBe(true);
      return { ok: true, account: "synthetic-gid", numInserted: 1 };
    },
  };
  const service = new EnableBankingService({
    authority: {
      profileId: "profile-a",
      isCurrent: () => current,
      isHolder: () => holder,
      isOwnerAction: () => owner,
    },
    secrets: {
      namespace: "synthetic-profile-a",
      async get(kind) {
        return secrets.get(kind) ?? null;
      },
      async set(kind, value) {
        secrets.set(kind, value);
      },
      async clear(kind) {
        secrets.delete(kind);
      },
    },
    imports: imported,
    redirectUrl: "https://127.0.0.1:18888/eb/callback",
    clock: { now: () => new Date("2026-11-04T00:00:00.000Z") },
    transport,
    callback: async (_redirect, state) => {
      consentState = state;
      return {
        redirectUrl: "https://127.0.0.1:18888/eb/callback",
        offer: () => undefined,
        wait: async () => "synthetic-code",
        close: async () => undefined,
      };
    },
  });
  expect((await service.beginConsent({ aspsp: "mBank" })).url).toBe(
    "https://synthetic-bank.example/consent",
  );
  expect(
    await service.completeConsent(
      `https://127.0.0.1:18888/eb/callback?state=${consentState}&code=synthetic-code`,
    ),
  ).toEqual({
    institution: "mbank",
    accounts: 1,
    inserted: 1,
    errors: [],
    attempts: [],
  });
  expect(imports).toBe(1);
  expect(await service.status()).toMatchObject({
    configured: true,
    sessions: [{ institution: "mbank" }],
    pendingAttempts: [{ key: "a".repeat(32), command: "banking.importAccount" }],
  });
  expect(service.attemptStatus("a".repeat(32))).toBe("not_started");
  exposeAttempt = false;
  expect(JSON.stringify(await service.status())).not.toContain("synthetic-session");
  const beforeLostLeadership = calls.length;
  holder = false;
  await expect(service.sync({ reason: "manual" })).rejects.toThrow("enable_banking_authorization");
  expect(calls).toHaveLength(beforeLostLeadership);
  holder = true;
  await service.sync({ reason: "daily" });
  expect(imports).toBe(1);
  limited = true;
  expect((await service.sync({ reason: "manual" })).errors).toEqual(["rate_limited"]);
  const callCount = calls.length;
  await service.sync({ reason: "manual" });
  expect(calls).toHaveLength(callCount);
  expect((await service.status()).sessions[0]?.backoffUntil).toBe("2026-11-04T20:00:00.000Z");
  owner = false;
  await expect(
    service.forgetSession((await service.status()).sessions[0]?.handle ?? ""),
  ).rejects.toThrow("enable_banking_authorization");
  holder = false;
  await expect(service.sync({ reason: "daily" })).rejects.toThrow("enable_banking_authorization");
  current = false;
  await expect(service.status()).rejects.toThrow("enable_banking_authorization");
  expect(calls).toContain("/accounts/synthetic-uid/transactions");
});

it("does not import or resurrect a session forgotten or reconfigured by another service instance", async () => {
  const namespace = `synthetic-race-${Math.random()}`;
  const values = new Map<string, string>([
    ["credentials", JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })],
    [
      "sessions",
      JSON.stringify([
        {
          id: "synthetic-session",
          institution: "mbank",
          savedAt: "2026-11-01T00:00:00.000Z",
          credentialRevision: "initial",
          lastSyncAt: null,
          backoffUntil: null,
        },
      ]),
    ],
  ]);
  let reached: (() => void) | undefined;
  let release: (() => void) | undefined;
  let hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let pausedKind: "credentials" | "sessions" | null = null;
  let resumeWrite: (() => void) | undefined;
  let signalWrite: (() => void) | undefined;
  const pauseWrite = (kind: "credentials" | "sessions") => {
    pausedKind = kind;
    const reachedWrite = new Promise<void>((resolve) => {
      signalWrite = resolve;
    });
    const holdWrite = new Promise<void>((resolve) => {
      resumeWrite = resolve;
    });
    return { reachedWrite, holdWrite };
  };
  let heldWrite: Promise<void> | null = null;
  let imports = 0;
  const secrets = {
    namespace,
    async get(kind: "credentials" | "sessions") {
      return values.get(kind) ?? null;
    },
    async set(kind: "credentials" | "sessions", value: string) {
      if (kind === pausedKind) {
        signalWrite?.();
        if (heldWrite) await heldWrite;
        pausedKind = null;
      }
      values.set(kind, value);
    },
    async clear(kind: "credentials" | "sessions") {
      values.delete(kind);
    },
  };
  const transport: BankingTransport = {
    async send(input) {
      if (input.url.pathname === "/sessions/synthetic-session") {
        reached?.();
        await hold;
        return {
          status: 200,
          text: JSON.stringify({ aspsp: { name: "mBank" }, accounts: ["synthetic-uid"] }),
        };
      }
      return {
        status: 200,
        text: JSON.stringify({
          account_id: { iban: null },
          currency: "PLN",
          transactions: [],
          balances: [],
        }),
      };
    },
  };
  const importsPort: BankingImportPort = {
    checkAttempt: () => "not_started",
    unresolvedAttempts: async () => [],
    async findAccount() {
      return null;
    },
    async runImport() {
      imports++;
      return { ok: true, account: "synthetic", numInserted: 0 };
    },
  };
  const make = () =>
    new EnableBankingService({
      authority: {
        profileId: "profile-a",
        isCurrent: () => true,
        isHolder: () => true,
        isOwnerAction: () => true,
      },
      secrets,
      imports: importsPort,
      redirectUrl: "https://127.0.0.1:18888/eb/callback",
      transport,
      clock: { now: () => new Date("2026-11-04T00:00:00.000Z") },
    });
  const first = make();
  const second = make();
  const handle = (await second.status()).sessions[0]?.handle;
  if (!handle) throw new Error("missing synthetic handle");
  const syncing = first.sync({ reason: "manual" });
  await pending;
  const pausedForget = pauseWrite("sessions");
  heldWrite = pausedForget.holdWrite;
  const forgetting = second.forgetSession(handle);
  await pausedForget.reachedWrite;
  release?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(imports).toBe(0);
  resumeWrite?.();
  await forgetting;
  await syncing;
  expect(imports).toBe(0);
  expect((await second.status()).sessions).toEqual([]);

  values.set(
    "sessions",
    JSON.stringify([
      {
        id: "synthetic-session",
        institution: "mbank",
        savedAt: "2026-11-01T00:00:00.000Z",
        credentialRevision: "initial",
        lastSyncAt: null,
        backoffUntil: null,
      },
    ]),
  );
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const again = first.sync({ reason: "manual" });
  await pending;
  const pausedConfigure = pauseWrite("credentials");
  heldWrite = pausedConfigure.holdWrite;
  const configuring = second.configure({ appId: "another-synthetic-app", privateKeyPem });
  await pausedConfigure.reachedWrite;
  release?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(imports).toBe(0);
  resumeWrite?.();
  await configuring;
  await again;
  expect(imports).toBe(0);
  expect((await second.status()).sessions).toEqual([]);
  expect(JSON.parse(values.get("credentials") ?? "{}").appId).toBe("another-synthetic-app");
});

it("closes the callback listener when authorization fails before completion", async () => {
  let closed = 0;
  const service = new EnableBankingService({
    authority: {
      profileId: "profile-a",
      isCurrent: () => true,
      isHolder: () => true,
      isOwnerAction: () => true,
    },
    secrets: {
      namespace: "synthetic-failed-begin",
      async get(kind) {
        return kind === "credentials"
          ? JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })
          : null;
      },
      async set() {
        throw new Error("unexpected write");
      },
      async clear() {
        throw new Error("unexpected clear");
      },
    },
    imports: {
      checkAttempt: () => "not_started",
      unresolvedAttempts: async () => [],
      async findAccount() {
        return null;
      },
      async runImport() {
        throw new Error("unexpected import");
      },
    },
    redirectUrl: "https://127.0.0.1:18888/eb/callback",
    callback: async () => ({
      redirectUrl: "https://127.0.0.1:18888/eb/callback",
      offer: () => undefined,
      wait: async () => "synthetic",
      close: async () => {
        closed++;
      },
    }),
    transport: {
      async send() {
        return { status: 500, text: "synthetic private error" };
      },
    },
  });
  await expect(service.beginConsent({ aspsp: "mBank" })).rejects.toThrow("enable_banking_response");
  expect(closed).toBe(1);
});

it("invalidates pending consent after credentials change before code exchange", async () => {
  const namespace = `synthetic-consent-${Math.random()}`;
  const values = new Map<string, string>([
    ["credentials", JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })],
  ]);
  const secrets = {
    namespace,
    async get(kind: "credentials" | "sessions") {
      return values.get(kind) ?? null;
    },
    async set(kind: "credentials" | "sessions", value: string) {
      values.set(kind, value);
    },
    async clear(kind: "credentials" | "sessions") {
      values.delete(kind);
    },
  };
  let state = "";
  let exchangeCalls = 0;
  const make = () =>
    new EnableBankingService({
      authority: {
        profileId: "profile-a",
        isCurrent: () => true,
        isHolder: () => true,
        isOwnerAction: () => true,
      },
      secrets,
      imports: {
        checkAttempt: () => "not_started",
        unresolvedAttempts: async () => [],
        async findAccount() {
          return null;
        },
        async runImport() {
          throw new Error("unexpected import");
        },
      },
      redirectUrl: "https://127.0.0.1:18888/eb/callback",
      callback: async (_redirect, captured) => {
        state = captured;
        return {
          redirectUrl: "https://127.0.0.1:18888/eb/callback",
          offer: () => undefined,
          wait: async () => "synthetic",
          close: async () => undefined,
        };
      },
      transport: {
        async send(input) {
          if (input.url.pathname === "/sessions") exchangeCalls++;
          return {
            status: 200,
            text: JSON.stringify({ url: "https://synthetic-bank.example/consent" }),
          };
        },
      },
    });
  const first = make();
  await first.beginConsent({ aspsp: "mBank" });
  await make().configure({ appId: "another-synthetic-app", privateKeyPem });
  await expect(
    first.completeConsent(`https://127.0.0.1:18888/eb/callback?state=${state}&code=synthetic`),
  ).rejects.toThrow("enable_banking_authorization");
  expect(exchangeCalls).toBe(0);
});

it("cancels a deferred authorization and refuses a concurrent begin", async () => {
  const values = new Map<string, string>([
    ["credentials", JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })],
  ]);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const sent = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closes = 0;
  let authCalls = 0;
  const service = new EnableBankingService({
    authority: {
      profileId: "profile-a",
      isCurrent: () => true,
      isHolder: () => true,
      isOwnerAction: () => true,
    },
    secrets: {
      namespace: `synthetic-deferred-${Math.random()}`,
      async get(kind) {
        return values.get(kind) ?? null;
      },
      async set(kind, value) {
        values.set(kind, value);
      },
      async clear(kind) {
        values.delete(kind);
      },
    },
    imports: {
      checkAttempt: () => "not_started",
      unresolvedAttempts: async () => [],
      async findAccount() {
        return null;
      },
      async runImport() {
        throw new Error("unexpected import");
      },
    },
    redirectUrl: "https://127.0.0.1:18888/eb/callback",
    callback: async () => ({
      redirectUrl: "https://127.0.0.1:18888/eb/callback",
      offer: () => undefined,
      wait: async () => "synthetic-code",
      close: async () => {
        closes++;
      },
    }),
    transport: {
      async send(input) {
        if (input.url.pathname === "/auth" && authCalls++ === 0) {
          entered?.();
          await gate;
        }
        return {
          status: 200,
          text: JSON.stringify({ url: "https://synthetic-bank.example/consent" }),
        };
      },
    },
  });
  const first = service.beginConsent({ aspsp: "mBank" });
  await sent;
  await expect(service.beginConsent({ aspsp: "mBank" })).rejects.toThrow(
    "enable_banking_authorization",
  );
  await service.cancelConsent();
  release?.();
  await expect(first).rejects.toThrow("enable_banking_authorization");
  expect((await service.status()).pendingConsent).toBeNull();
  expect(closes).toBeGreaterThanOrEqual(1);
  expect((await service.beginConsent({ aspsp: "mBank" })).url).toBe(
    "https://synthetic-bank.example/consent",
  );
  await service.cancelConsent();
});

it("is ready for an immediate retry after Enable Banking refuses the bank name", async () => {
  const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  let listening = 0;
  let closes = 0;
  const asked: string[] = [];
  const service = new EnableBankingService({
    authority: {
      profileId: "profile-a",
      isCurrent: () => true,
      isHolder: () => true,
      isOwnerAction: () => true,
    },
    secrets: {
      namespace: "synthetic-retry-begin",
      async get(kind) {
        return kind === "credentials"
          ? JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })
          : null;
      },
      async set() {
        throw new Error("unexpected write");
      },
      async clear() {
        throw new Error("unexpected clear");
      },
    },
    imports: {
      checkAttempt: () => "not_started",
      unresolvedAttempts: async () => [],
      async findAccount() {
        return null;
      },
      async runImport() {
        throw new Error("unexpected import");
      },
    },
    redirectUrl: "https://127.0.0.1:18888/eb/callback",
    callback: async () => {
      // One listener at a time on the callback port: a second one before close would fail.
      if (listening - closes !== 0) throw new Error("callback port still in use");
      listening++;
      return {
        redirectUrl: "https://127.0.0.1:18888/eb/callback",
        offer: () => undefined,
        wait: async () => "synthetic",
        close: async () => {
          closes++;
        },
      };
    },
    transport: {
      async send(input) {
        const body = JSON.parse(input.body ?? "{}") as { aspsp?: { name?: string } };
        asked.push(body.aspsp?.name ?? "");
        return body.aspsp?.name === "Synthetic Bank"
          ? { status: 200, text: JSON.stringify({ url: "https://synthetic-bank.example/consent" }) }
          : { status: 422, text: "synthetic unknown ASPSP" };
      },
    },
  });
  await expect(service.beginConsent({ aspsp: "Synthetic Bnak" })).rejects.toThrow(
    "enable_banking_response",
  );
  expect((await service.status()).pendingConsent).toBeNull();
  expect(closes).toBe(1);
  expect((await service.beginConsent({ aspsp: "Synthetic Bank" })).url).toBe(
    "https://synthetic-bank.example/consent",
  );
  expect(asked).toEqual(["Synthetic Bnak", "Synthetic Bank"]);
  await service.cancelConsent();
});

it.each([
  ["REDIRECT_URI_NOT_ALLOWED", 400, "enable_banking_redirect_not_allowed"],
  ["WRONG_ASPSP_PROVIDED", 422, "enable_banking_unknown_bank"],
  ["NO_ACCOUNTS_ADDED", 403, "enable_banking_app_restricted"],
  ["WRONG_REQUEST_PARAMETERS", 422, "enable_banking_response"],
  ["NOT A CODE <script>", 422, "enable_banking_response"],
] as const)("maps Enable Banking's %s on /auth to its own refusal", async (code, status, fault) => {
  const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const service = new EnableBankingService({
    authority: {
      profileId: "profile-a",
      isCurrent: () => true,
      isHolder: () => true,
      isOwnerAction: () => true,
    },
    secrets: {
      namespace: `synthetic-auth-${code}`,
      async get(kind) {
        return kind === "credentials"
          ? JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })
          : null;
      },
      async set() {
        throw new Error("unexpected write");
      },
      async clear() {
        throw new Error("unexpected clear");
      },
    },
    imports: {
      checkAttempt: () => "not_started",
      unresolvedAttempts: async () => [],
      async findAccount() {
        return null;
      },
      async runImport() {
        throw new Error("unexpected import");
      },
    },
    redirectUrl: "https://127.0.0.1:18888/eb/callback",
    callback: async () => ({
      redirectUrl: "https://127.0.0.1:18888/eb/callback",
      offer: () => undefined,
      wait: async () => "synthetic",
      close: async () => {},
    }),
    transport: {
      async send() {
        return {
          status,
          text: JSON.stringify({ message: "synthetic private detail", code: status, error: code }),
        };
      },
    },
  });
  const failure = await service.beginConsent({ aspsp: "Synthetic Bank" }).catch((error) => error);
  expect(String(failure)).toContain(fault);
  expect(String(failure)).not.toContain("synthetic private detail");
});

it("ends a waited consent definitely when the owner cancels, and connects again at once", async () => {
  const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  let open = 0;
  const service = new EnableBankingService({
    authority: {
      profileId: "profile-a",
      isCurrent: () => true,
      isHolder: () => true,
      isOwnerAction: () => true,
    },
    secrets: {
      namespace: "synthetic-cancel-wait",
      async get(kind) {
        return kind === "credentials"
          ? JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })
          : null;
      },
      async set() {
        throw new Error("unexpected write");
      },
      async clear() {
        throw new Error("unexpected clear");
      },
    },
    imports: {
      checkAttempt: () => "not_started",
      unresolvedAttempts: async () => [],
      async findAccount() {
        return null;
      },
      async runImport() {
        throw new Error("unexpected import");
      },
    },
    redirectUrl: "https://127.0.0.1:18888/eb/callback",
    callback: async () => {
      if (open > 0) throw new Error("callback port still in use");
      open++;
      let fail: ((error: Error) => void) | undefined;
      const answer = new Promise<string>((_, reject) => {
        fail = reject;
      });
      void answer.catch(() => undefined);
      return {
        redirectUrl: "https://127.0.0.1:18888/eb/callback",
        wait: () => answer,
        offer: () => undefined,
        close: async () => {
          if (!fail) return;
          open--;
          fail(new BankingFault("consent_cancelled"));
          fail = undefined;
        },
      };
    },
    transport: {
      async send() {
        return {
          status: 200,
          text: JSON.stringify({ url: "https://synthetic-bank.example/consent" }),
        };
      },
    },
  });
  await service.beginConsent({ aspsp: "Synthetic Bank" });
  const waiting = service.completeConsent();
  await new Promise<void>((resolve) => setImmediate(resolve));
  // The window opens the bank's page while cashU waits: the URL stays the pending consent's.
  expect((await service.status()).pendingConsent).toBe("https://synthetic-bank.example/consent");
  // One waiter per consent.
  await expect(service.completeConsent()).rejects.toThrow("enable_banking_authorization");
  // While the bank's answer is awaited, a second consent cannot start.
  await expect(service.beginConsent({ aspsp: "Synthetic Bank" })).rejects.toThrow(
    "enable_banking_authorization",
  );
  await service.cancelConsent();
  await expect(waiting).rejects.toThrow("enable_banking_consent_cancelled");
  expect(open).toBe(0);
  expect((await service.status()).pendingConsent).toBeNull();
  expect((await service.beginConsent({ aspsp: "Synthetic Bank" })).url).toBe(
    "https://synthetic-bank.example/consent",
  );
  await service.cancelConsent();
});

it("reports a callback port it cannot open as its own refusal", async () => {
  const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const service = new EnableBankingService({
    authority: {
      profileId: "profile-a",
      isCurrent: () => true,
      isHolder: () => true,
      isOwnerAction: () => true,
    },
    secrets: {
      namespace: "synthetic-callback-busy",
      async get(kind) {
        return kind === "credentials"
          ? JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })
          : null;
      },
      async set() {
        throw new Error("unexpected write");
      },
      async clear() {
        throw new Error("unexpected clear");
      },
    },
    imports: {
      checkAttempt: () => "not_started",
      unresolvedAttempts: async () => [],
      async findAccount() {
        return null;
      },
      async runImport() {
        throw new Error("unexpected import");
      },
    },
    redirectUrl: "https://127.0.0.1:18888/eb/callback",
    callback: async () => {
      throw new Error("EADDRINUSE");
    },
    transport: {
      async send() {
        throw new Error("unexpected request");
      },
    },
  });
  await expect(service.beginConsent({ aspsp: "Synthetic Bank" })).rejects.toThrow(
    "enable_banking_callback",
  );
});

it("stops a daily sync after network authority loss before account import", async () => {
  const values = new Map<string, string>([
    ["credentials", JSON.stringify({ appId: "synthetic-app", privateKeyPem, revision: "initial" })],
    [
      "sessions",
      JSON.stringify([
        {
          id: "session",
          institution: "mbank",
          savedAt: "2026-11-01T00:00:00Z",
          credentialRevision: "initial",
          lastSyncAt: null,
          backoffUntil: null,
        },
      ]),
    ],
  ]);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const sent = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let allowed = true;
  let imports = 0;
  const calls: string[] = [];
  const service = new EnableBankingService({
    authority: {
      profileId: "profile-a",
      isCurrent: () => true,
      isHolder: () => true,
      isOwnerAction: () => false,
    },
    secrets: {
      namespace: `synthetic-worker-${Math.random()}`,
      async get(kind) {
        return values.get(kind) ?? null;
      },
      async set(kind, value) {
        values.set(kind, value);
      },
      async clear(kind) {
        values.delete(kind);
      },
    },
    imports: {
      checkAttempt: () => "not_started",
      unresolvedAttempts: async () => [],
      async findAccount() {
        return null;
      },
      async runImport() {
        imports++;
        return { ok: true, account: "synthetic", numInserted: 1 };
      },
    },
    redirectUrl: "https://127.0.0.1:18888/eb/callback",
    transport: {
      async send(input) {
        calls.push(input.url.pathname);
        if (input.url.pathname === "/sessions/session") {
          entered?.();
          await gate;
        }
        return {
          status: 200,
          text: JSON.stringify({
            status: "AUTHORIZED",
            aspsp: { name: "mBank" },
            accounts: ["synthetic-uid"],
          }),
        };
      },
    },
  });
  const sync = service.sync({
    reason: "daily",
    guard: () => {
      if (!allowed) throw new Error("lost");
    },
  });
  await sent;
  allowed = false;
  release?.();
  expect((await sync).errors).toContain("authorization");
  expect(calls).toEqual(["/sessions/session"]);
  expect(imports).toBe(0);
});
