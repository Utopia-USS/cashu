// Native consumer, actual all-vault gate and real Anthropic transport. Only fetch/model I/O is fake;
// native imports, rule materialization, write queue, eligibility versions and owner writes are real.
import { type budget, D } from "@cashu/domain";
import { createTranslator } from "@cashu/i18n";
import type { CloudCredentials, CurrentCloudConfig, ReviewedCloudConsent } from "@cashu/llm";
import { type Command, importStatement, runCommand, setMerchantCategory } from "@cashu/store";
import { budgetBook } from "@cashu/store/budget/queries";
import { afterEach, expect, it, vi } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import type { CommandIo } from "../tree.js";
import { runCategorizeCommand } from "./categorizeCommands.js";
import type { CloudCategorizeProvider } from "./categorizeOllama.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  cleanup();
});

type Fact = { merchant: string; amount?: string; iban?: string; description?: string };

async function fixture() {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  closers.push(async () => {
    await host.stop();
  });
  const opened = [...host.stores.vaults.values()][0];
  if (!opened) throw new Error("missing synthetic native vault");
  const vault = opened;
  const state = {
    authority: true,
    consent: true,
    consentAvailable: true,
    config: true,
    configAvailable: true,
    key: "synthetic-key" as string | null,
    wrongVault: false,
    throwGuard: false,
    textRead: false,
    ownerScheduled: false,
  };
  const requests: { url: string; merchants: string[] }[] = [];
  let action: (() => Promise<void> | void) | undefined;
  let afterText = false;
  let ownerRace = false;
  let stdout = "",
    stderr = "";
  let serial = 0;
  const controller = new AbortController();
  const env = { CASHU_CATEGORIZE_LLM_BACKEND: "anthropic" };
  const io: CommandIo = {
    cwd: tempDir(),
    env,
    t: createTranslator("en"),
    tty: { stdin: false, stdout: false, stderr: false },
    signal: controller.signal,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    prompt: async () => {
      throw new Error("unexpected synthetic prompt");
    },
    stdin: () => {
      throw new Error("unexpected synthetic stdin");
    },
  };
  function run<I, R>(command: Command<I, R>, input: unknown): R {
    const outcome = runCommand(vault.store, vault.writer, command, input, vault.env);
    if (!outcome.ok) throw new Error(`synthetic command refused: ${outcome.reason}`);
    return outcome.value;
  }
  async function insert(facts: readonly Fact[]) {
    const rows: budget.RawTransaction[] = facts.map((fact) => ({
      bookingDate: "2026-09-01",
      valueDate: null,
      amount: D(fact.amount ?? "-11.11"),
      currency: "PLN",
      counterpartyName: fact.merchant,
      counterpartyIban: fact.iban ?? null,
      description: fact.description ?? "PŁATNOŚĆ KARTĄ",
      reference: null,
      bankTransactionId: `synthetic-${serial++}`,
      source: "csv",
      raw: { synthetic: true },
    }));
    await vault.queue.run(() =>
      run(importStatement, {
        statement: {
          bank: "mbank",
          accountNumber: null,
          accountName: "Synthetic cloud account",
          currency: "PLN",
          transactions: rows,
          balances: [],
          closingBalances: [],
        },
        newestDayRule: false,
      }),
    );
  }
  const ownerWrite = () =>
    run(setMerchantCategory, { merchantKey: "SKLEP UNIKAT 00", category: "travel" });
  class Consent implements ReviewedCloudConsent {
    get vault() {
      return state.wrongVault ? "other-vault" : vault.id;
    }
    readonly riskCopy = "merchant-name-residual-v1" as const;
    isCurrent() {
      return state.consent;
    }
  }
  class Config implements CurrentCloudConfig {
    model = "synthetic-model";
    endpoint = ENDPOINT;
    isCurrent() {
      return state.config;
    }
  }
  class Credentials implements CloudCredentials {
    #state = state;
    async apiKey() {
      return this.#state.key;
    }
  }
  const config = new Config(),
    consent = new Consent();
  class Provider implements CloudCategorizeProvider {
    #state = state;
    readonly credentials = new Credentials();
    isHolder(id: string) {
      if (this.#state.throwGuard) {
        this.#state.throwGuard = false;
        throw new Error("private provider detail");
      }
      if (ownerRace && this.#state.textRead && !this.#state.ownerScheduled) {
        this.#state.ownerScheduled = true;
        queueMicrotask(() => {
          void vault.queue.run(ownerWrite);
        });
      }
      return id === vault.id && this.#state.authority;
    }
    consent() {
      return this.#state.consentAvailable ? consent : null;
    }
    config() {
      return this.#state.configAvailable ? config : null;
    }
    async fetch(
      url: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ): Promise<Response> {
      // Private receiver proves the host preserves prototype capabilities rather than spreading them.
      if (!this.#state) throw new Error("missing synthetic provider receiver");
      if (typeof url !== "string" || typeof init?.body !== "string")
        throw new Error("bad synthetic request shape");
      const body = JSON.parse(init.body);
      const listing = body.messages[0].content;
      const items = JSON.parse(listing.slice(listing.indexOf("\n") + 1)) as {
        id: string;
        merchant: string;
      }[];
      requests.push({ url, merchants: items.map((item) => item.merchant) });
      expect(init.redirect).toBe("manual");
      if (action) await action();
      const response = new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: items.map((item) => ({
                  id: item.id,
                  category: "groceries",
                  confidence: 0.8,
                })),
              }),
            },
          ],
        }),
      );
      if (afterText) {
        const text = response.text.bind(response);
        vi.spyOn(response, "text").mockImplementation(async () => {
          const value = await text();
          state.textRead = true;
          return value;
        });
      }
      return response;
    }
  }
  const provider = new Provider();
  const localFetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error("unexpected local fallback");
  });
  const execute = (enabled = true) =>
    runCategorizeCommand(
      "categorize",
      ["--llm"],
      io,
      { profile: "demo" },
      {
        stores: host.stores,
        now: Date.now,
        classifier: { isHolder: () => true, fetch: localFetch },
        ...(enabled ? { cloudClassifier: provider } : {}),
      },
    );
  const rules = () =>
    vault.store.read<{ merchant_key: string; category: string; source: string; locked: number }>(
      "SELECT merchant_key, category, source, locked FROM category_rules ORDER BY merchant_key",
    );
  return {
    state,
    provider,
    config,
    controller,
    requests,
    insert,
    execute,
    rules,
    localFetch,
    vault,
    stdout: () => stdout,
    stderr: () => stderr,
    action: (callback: typeof action) => {
      action = callback;
    },
    raceOwner: () => {
      afterText = true;
      ownerRace = true;
    },
    backend: (value: string) => {
      env.CASHU_CATEGORIZE_LLM_BACKEND = value;
    },
  };
}

it("uses class-backed capabilities and excludes any key tainted anywhere in the real vault", async () => {
  const f = await fixture();
  await f.insert([
    { merchant: "SKLEP UNIKAT 00" },
    { merchant: "SKLEP UNIKAT 01" },
    { merchant: "SKLEP UNIKAT 01", amount: "1.00", iban: "PL10114000000000000000009999" },
    { merchant: "SKLEP UNIKAT 02" },
    { merchant: "SKLEP UNIKAT 02", amount: "1.00", description: "BLIK NA TELEFON" },
  ]);
  expect(await f.execute()).toBe(0);
  expect(f.requests).toEqual([{ url: ENDPOINT, merchants: ["SKLEP UNIKAT 00"] }]);
  expect(f.rules()).toEqual([
    { merchant_key: "SKLEP UNIKAT 00", category: "groceries", source: "llm", locked: 0 },
  ]);
  expect(f.stdout()).toContain("+1 rules (1 unknown expense merchants)");
  expect(f.localFetch).not.toHaveBeenCalled();
});

it.each([
  "provider",
  "consent",
  "credentials",
  "credential provider",
  "config",
  "wrong vault",
  "throwing guard",
] as const)(
  "refuses missing/invalid %s without request, cache append or local/Python fallback",
  async (missing) => {
    const f = await fixture();
    await f.insert([{ merchant: "SKLEP UNIKAT 00" }]);
    if (missing === "consent") f.state.consentAvailable = false;
    if (missing === "credentials") f.state.key = null;
    if (missing === "credential provider") Object.assign(f.provider, { credentials: undefined });
    if (missing === "config") f.state.configAvailable = false;
    if (missing === "wrong vault") f.state.wrongVault = true;
    if (missing === "throwing guard") f.state.throwGuard = true;
    expect(await f.execute(missing !== "provider")).toBe(1);
    expect(f.requests).toEqual([]);
    expect(f.rules()).toEqual([]);
    expect(f.localFetch).not.toHaveBeenCalled();
    expect(f.stdout()).toBe("");
    expect(f.stderr()).not.toMatch(/private provider detail|synthetic-key/);
  },
);

it("invalidates a real41-key snapshot between batches and appends no partial model rules", async () => {
  const f = await fixture();
  await f.insert(
    Array.from({ length: 41 }, (_, i) => ({
      merchant: `SKLEP UNIKAT ${String(i).padStart(2, "0")}`,
    })),
  );
  f.action(async () => {
    await f.insert([
      { merchant: "SKLEP UNIKAT 40", amount: "1.00", iban: "PL10114000000000000000009999" },
    ]);
  });
  expect(await f.execute()).toBe(1);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.merchants).toHaveLength(40);
  expect(f.rules()).toEqual([]);
  expect(f.localFetch).not.toHaveBeenCalled();
});

it.each([
  "authority",
  "consent",
  "config",
  "model in place",
  "endpoint in place",
  "backend",
] as const)("refuses %s changes after the request without caching its response", async (change) => {
  const f = await fixture();
  await f.insert([{ merchant: "SKLEP UNIKAT 00" }]);
  f.action(() => {
    if (change === "authority") f.state.authority = false;
    if (change === "consent") f.state.consent = false;
    if (change === "config") f.state.config = false;
    if (change === "model in place") f.config.model = "changed-model";
    if (change === "endpoint in place") f.config.endpoint = "https://unapproved.invalid/";
    if (change === "backend") f.backend("ollama");
  });
  expect(await f.execute()).toBe(1);
  expect(f.requests).toHaveLength(1);
  expect(f.rules()).toEqual([]);
  expect(f.localFetch).not.toHaveBeenCalled();
});

it("preserves an owner manual rule arriving after response text and before the queued cache append", async () => {
  const f = await fixture();
  await f.insert([{ merchant: "SKLEP UNIKAT 00" }]);
  f.raceOwner();
  expect(await f.execute()).toBe(1);
  expect(f.state.ownerScheduled).toBe(true);
  expect(f.requests).toHaveLength(1);
  expect(f.rules()).toEqual([
    { merchant_key: "SKLEP UNIKAT 00", category: "travel", source: "manual", locked: 1 },
  ]);
  expect(budgetBook(f.vault.store.read.bind(f.vault.store)).transactions[0]).toMatchObject({
    category: "travel",
    categorySource: "manual",
  });
});
