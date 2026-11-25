// `categorize --llm`: a bank's generic operation phrase (no counterparty, no title) is never sent to
// a merchant classifier, local or cloud. Only fetch is fake; the native vault, gate and transport are real.
import { type budget, D } from "@cashu/domain";
import { createTranslator } from "@cashu/i18n";
import type { CloudCredentials, CurrentCloudConfig, ReviewedCloudConsent } from "@cashu/llm";
import { type Command, importStatement, runCommand, setModules } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import type { CommandIo } from "../tree.js";
import { runCategorizeCommand } from "./categorizeCommands.js";
import type { CloudCategorizeProvider } from "./categorizeOllama.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  cleanup();
});

// Synthetic outflows: three generic phrases (as the bank writes them) and one real merchant.
const ROWS: readonly { counterparty: string | null; description: string }[] = [
  { counterparty: null, description: "ZAKUP PRZY UŻYCIU KARTY" },
  { counterparty: null, description: "PRZELEW" },
  { counterparty: "BLIK", description: "PŁATNOŚĆ KARTĄ" },
  { counterparty: "SKLEP UNIKAT 00", description: "PŁATNOŚĆ KARTĄ" },
];
/** The merchant strings one request body lists (the user message's item list of each backend). */
function listedMerchants(backend: "ollama" | "anthropic", raw: string): string[] {
  const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
  const user = body.messages.filter((m) => m.role === "user").map((m) => m.content);
  expect(user).toHaveLength(1);
  const content = user[0] ?? "";
  if (backend === "anthropic")
    return (JSON.parse(content.slice(content.indexOf("\n") + 1)) as { merchant: string }[]).map(
      (item) => item.merchant,
    );
  return [...content.matchAll(/^m\d+: (.*)$/gmu)].map((match) => match[1] ?? "");
}

async function fixture(backend: "ollama" | "anthropic") {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  closers.push(async () => {
    await host.stop();
  });
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("missing synthetic native vault");
  const run = <I, R>(command: Command<I, R>, input: unknown) => {
    const outcome = runCommand(vault.store, vault.writer, command, input, vault.env);
    if (!outcome.ok) throw new Error(`synthetic command refused: ${outcome.reason}`);
  };
  run(setModules, { moduleIds: ["budget"] });
  const transactions: budget.RawTransaction[] = ROWS.map((row, i) => ({
    bookingDate: "2026-09-01",
    valueDate: null,
    amount: D("-11.11"),
    currency: "PLN",
    counterpartyName: row.counterparty,
    counterpartyIban: null,
    description: row.description,
    reference: null,
    bankTransactionId: `synthetic-${i}`,
    source: "csv",
    raw: { synthetic: true },
  }));
  await vault.queue.run(() =>
    run(importStatement, {
      statement: {
        bank: "mbank",
        accountNumber: null,
        accountName: "Synthetic account",
        currency: "PLN",
        transactions,
        balances: [],
        closingBalances: [],
      },
      newestDayRule: false,
    }),
  );
  // Every request body a classifier port is handed, verbatim.
  const bodies: string[] = [];
  const io: CommandIo = {
    cwd: tempDir(),
    env: { CASHU_CATEGORIZE_LLM_BACKEND: backend },
    t: createTranslator("en"),
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    stdout() {},
    stderr() {},
    prompt: async () => {
      throw new Error("unexpected synthetic prompt");
    },
    stdin: () => {
      throw new Error("unexpected synthetic stdin");
    },
  };
  const localFetch = async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ message: { content: '{"results":[]}' } }));
  };
  const consent: ReviewedCloudConsent = {
    vault: vault.id,
    riskCopy: "merchant-name-residual-v1",
    isCurrent: () => true,
  };
  const config: CurrentCloudConfig = {
    model: "synthetic-model",
    endpoint: "https://api.anthropic.com/v1/messages",
    isCurrent: () => true,
  };
  const credentials: CloudCredentials = { apiKey: async () => "synthetic-key" };
  const cloud: CloudCategorizeProvider = {
    credentials,
    isHolder: (id) => id === vault.id,
    consent: () => consent,
    config: () => config,
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"results":[]}' }] }));
    },
  };
  await runCategorizeCommand(
    "categorize",
    ["--llm"],
    io,
    { profile: "demo" },
    {
      stores: host.stores,
      now: Date.now,
      classifier: { isHolder: () => true, fetch: localFetch },
      ...(backend === "anthropic" ? { cloudClassifier: cloud } : {}),
    },
  );
  return bodies;
}

it.each(["ollama", "anthropic"] as const)(
  "%s: the classifier receives the merchant, never a generic bank phrase",
  async (backend) => {
    const bodies = await fixture(backend);
    expect(bodies).toHaveLength(1);
    expect(bodies.flatMap((body) => listedMerchants(backend, body))).toEqual(["SKLEP UNIKAT 00"]);
  },
);
