// Authority and local-only routing are independent of model output and never use scaffold leases.
import { budget } from "@cashu/domain";
import { createTranslator } from "@cashu/i18n";
import { expect, it } from "vitest";
import type { CommandIo } from "../tree.js";
import {
  type CategorizeProvider,
  ClassifierAuthorityLost,
  OllamaClassifier,
  ollamaOptions,
} from "./categorizeOllama.js";

function io(env: Record<string, string> = {}): CommandIo {
  return {
    cwd: "/tmp",
    env,
    t: createTranslator("en"),
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    stdout() {},
    stderr() {},
    prompt: async () => null,
    stdin: async function* () {},
  };
}
it("preserves class-backed providers and refuses missing or changed input currentness", async () => {
  const source = { version: 1 };
  const captured = source.version;
  class Provider implements CategorizeProvider {
    readonly held = new Set(["synthetic"]);
    calls = 0;
    isHolder(vault: string) {
      return this.held.has(vault);
    }
    async fetch() {
      this.calls += 1;
      source.version += 1;
      return new Response(JSON.stringify({ message: { content: '{"results":[]}' } }));
    }
  }
  const provider = new Provider();
  const options = { url: "http://localhost:11434", model: "synthetic" };
  const unavailable = new OllamaClassifier(provider, "synthetic", io(), options);
  await expect(
    unavailable.classifyMerchants(["QWERTYMART"], budget.AUTO_CATEGORY_KEYS),
  ).rejects.toBeInstanceOf(ClassifierAuthorityLost);
  expect(provider.calls).toBe(0);
  const client = new OllamaClassifier(
    provider,
    "synthetic",
    io(),
    options,
    (vault) => vault === "synthetic" && source.version === captured,
  );
  await expect(
    client.classifyMerchants(["QWERTYMART"], budget.AUTO_CATEGORY_KEYS),
  ).rejects.toBeInstanceOf(ClassifierAuthorityLost);
  expect(provider.calls).toBe(1);
});
it("enforces loopback at the adapter boundary and snapshots validated caller options", async () => {
  const targets: string[] = [];
  const provider: CategorizeProvider = {
    isHolder: () => true,
    fetch: async (url) => {
      targets.push(String(url));
      return new Response(JSON.stringify({ message: { content: '{"results":[]}' } }));
    },
  };
  expect(
    () =>
      new OllamaClassifier(provider, "synthetic", io(), {
        url: "https://example.invalid",
        model: "synthetic",
      }),
  ).toThrow("loopback endpoint");
  const options = { url: "http://localhost:11434/", model: "synthetic" };
  const input = { version: 1 };
  const captured = input.version;
  const client = new OllamaClassifier(
    provider,
    "synthetic",
    io(),
    options,
    (id) => id === "synthetic" && input.version === captured,
  );
  options.url = "https://example.invalid";
  await client.classifyMerchants(["UNKNOWN"], budget.AUTO_CATEGORY_KEYS);
  expect(targets).toEqual(["http://localhost:11434/api/chat"]);
});
it("accepts only local endpoints and refuses network work after fetch authority changes", async () => {
  for (const url of [
    "https://example.invalid",
    "http://127.0.0.1.example.invalid",
    "http://user:secret@localhost",
    "http://localhost?query=x",
  ])
    expect(ollamaOptions(io({ CASHU_CATEGORIZE_OLLAMA_URL: url }))).toBeUndefined();
  expect(ollamaOptions(io({ CASHU_CATEGORIZE_OLLAMA_URL: "http://[::1]:11434" }))).toBeDefined();
  let holder = false,
    calls = 0;
  const provider: CategorizeProvider = {
    isHolder: () => holder,
    fetch: async (_url, init) => {
      calls++;
      expect(init?.redirect).toBe("manual");
      holder = false;
      return new Response(
        JSON.stringify({
          message: { content: JSON.stringify({ results: [{ id: "m0", category: "groceries" }] }) },
        }),
      );
    },
  };
  const input = { version: 1 };
  const captured = input.version;
  const client = new OllamaClassifier(
    provider,
    "synthetic",
    io(),
    {
      url: "http://localhost:11434",
      model: "synthetic",
    },
    (id) => id === "synthetic" && input.version === captured,
  );
  await expect(
    client.classifyMerchants(["UNKNOWN"], budget.AUTO_CATEGORY_KEYS),
  ).rejects.toBeInstanceOf(ClassifierAuthorityLost);
  expect(calls).toBe(0);
  holder = true;
  await expect(
    client.classifyMerchants(["UNKNOWN"], budget.AUTO_CATEGORY_KEYS),
  ).rejects.toBeInstanceOf(ClassifierAuthorityLost);
  expect(calls).toBe(1);
});
it("uses the reviewed reply parser to reject hallucinated cross-batch transaction ids", async () => {
  const requests: RequestInit[] = [];
  const provider: CategorizeProvider = {
    isHolder: () => true,
    fetch: async (_url, init) => {
      requests.push(init ?? {});
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              results: [
                { id: "t0", category: "shopping", confidence: 4 },
                { id: "t99", category: "transfer" },
              ],
            }),
          },
        }),
      );
    },
  };
  const input = { version: 1 };
  const captured = input.version;
  const client = new OllamaClassifier(
    provider,
    "synthetic",
    io(),
    {
      url: "http://localhost:11434",
      model: "synthetic",
    },
    (id) => id === "synthetic" && input.version === captured,
  );
  const results = await client.classifyTransactions(
    [["t0", "Synthetic local context"]],
    budget.RECLASSIFY_KEYS,
    new Map([["shopping", "Zakupy"]]),
    { batchSize: 1 },
  );
  expect([...results]).toEqual([["t0", { category: "shopping", confidence: 1 }]]);
  expect(requests).toHaveLength(1);
});
