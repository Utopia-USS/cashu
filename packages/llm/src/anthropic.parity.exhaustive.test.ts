// Frozen Python HTTPX MockTransport oracle. Runs in the existing serial exhaustive tier.
// Expectations captured from the retired oracle (packages/llm/test-fixtures/anthropic-oracle.py over
// cashu.modules.budget.categorize.llm.classify_merchants) on 2026-11-04, one fixture entry per case.
import { budget, D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { AnthropicClassifier } from "./anthropic.js";
import oracleFixture from "./fixtures/anthropicOracle.json" with { type: "json" };
import type { ClassifierDiagnostic, ClassifierTransportContext } from "./ports.js";

const KEYS = ["groceries", "fuel"];
const result = (items: unknown) => ({
  content: [{ type: "text", text: JSON.stringify({ results: items }) }],
});
const answer = { id: "m0", category: "groceries", confidence: 0.8 };
type Reply = {
  status?: number;
  json?: unknown;
  text?: string;
  raises?: boolean;
  headers?: Record<string, string>;
};

function eligible(n: number): budget.CloudMerchant[] {
  return budget.cloudMerchants(
    Array.from({ length: n }, (_, i) => ({
      amount: D("-4321.98"),
      counterpartyName: `SKLEP UNIKAT ${String(i).padStart(2, "0")}`,
      counterpartyIban: null,
      description: "PŁATNOŚĆ KARTĄ",
      reference: null,
      isInternalTransfer: false,
      source: "default",
    })),
  );
}

const ORACLE = oracleFixture as Record<
  string,
  {
    requests: { url: string; headers: Record<string, string>; body: string }[];
    timeouts: number[];
    answers: Record<string, { category: string; confidence: number }>;
    failed_batches: number;
  }
>;

const CASES: readonly { name: string; count: number; responses: readonly Reply[] }[] = [
  { name: "valid", count: 1, responses: [{ json: result([answer]) }] },
  { name: "empty", count: 1, responses: [{ json: result([]) }] },
  {
    name: "unknown ids and closed categories",
    count: 1,
    responses: [
      {
        json: result([
          { id: "not-in-this-batch", category: "fuel", confidence: 1 },
          { id: "m0", category: "invented", confidence: 9 },
        ]),
      },
    ],
  },
  { name: "HTTP error", count: 1, responses: [{ status: 503, text: "private synthetic error" }] },
  {
    name: "redirect",
    count: 1,
    responses: [
      { status: 307, headers: { location: "https://unapproved.invalid/" }, text: "redirect" },
    ],
  },
  { name: "network error", count: 1, responses: [{ raises: true }] },
  { name: "outer JSON", count: 1, responses: [{ text: "{" }] },
  {
    name: "inner JSON",
    count: 1,
    responses: [{ json: { content: [{ type: "text", text: "{" }] } }],
  },
  {
    name: "partial batch continuation",
    count: 81,
    responses: [
      { json: result([answer]) },
      { status: 503, text: "synthetic" },
      { json: result([answer]) },
    ],
  },
];

describe("cloud transport against actual isolated Python classifier", () => {
  it.each(CASES)("$name", async ({ name, count, responses }) => {
    const merchants = eligible(count);
    expect(merchants).toHaveLength(count);
    const oracle = ORACLE[name];
    if (!oracle) throw new Error(`missing frozen oracle for ${name}`);
    const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
    const diagnostics: ClassifierDiagnostic[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || typeof init?.body !== "string")
        throw new Error("unexpected synthetic request shape");
      const headers = new Headers(init.headers);
      const response = responses[Math.min(requests.length, responses.length - 1)];
      if (!response) throw new Error("missing synthetic response");
      requests.push({
        url,
        body: init.body,
        headers: {
          "x-api-key": headers.get("x-api-key") ?? "",
          "anthropic-version": headers.get("anthropic-version") ?? "",
          "content-type": headers.get("content-type") ?? "",
        },
      });
      expect(init.redirect).toBe("manual");
      if (response.raises) throw new Error("synthetic transport failure");
      return new Response("text" in response ? response.text : JSON.stringify(response.json), {
        status: response.status ?? 200,
        headers: response.headers,
      });
    };
    const context: ClassifierTransportContext = {
      vault: "synthetic-vault",
      isHolder: () => true,
      isInputCurrent: () => true,
      fetch,
      signal: new AbortController().signal,
      onDiagnostic: (event) => diagnostics.push(event),
    };
    const classifier = new AnthropicClassifier(
      context,
      { vault: context.vault, riskCopy: "merchant-name-residual-v1", isCurrent: () => true },
      { apiKey: async () => "synthetic-key" },
      {
        model: "synthetic-model",
        endpoint: "https://api.anthropic.com/v1/messages",
        isCurrent: () => true,
      },
    );
    const actual = await classifier.classifyCloudMerchants(merchants, KEYS);
    expect(requests).toEqual(oracle.requests);
    expect(oracle.timeouts).toEqual([60]);
    expect(actual.ok ? Object.fromEntries(actual.answers) : {}).toEqual(oracle.answers);
    expect(diagnostics).toHaveLength(oracle.failed_batches);
  });
});
