// Independent actual Python HTTPX MockTransport oracle. Runs in the existing serial exhaustive
// tier, with isolated HOME/data/workspaces/legacy/agents and no credential or network environment.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budget, D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { AnthropicClassifier } from "./anthropic.js";
import type { ClassifierDiagnostic, ClassifierTransportContext } from "./ports.js";

const ROOT = resolve(import.meta.dirname, "../../..");
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

function python(merchants: readonly budget.CloudMerchant[], responses: readonly Reply[]) {
  const home = mkdtempSync(join(tmpdir(), "cashu-llm-oracle-"));
  const data = join(home, "data");
  mkdirSync(data);
  try {
    const child = spawnSync(
      join(ROOT, ".venv/bin/python"),
      [join(ROOT, "packages/llm/test-fixtures/anthropic-oracle.py")],
      {
        encoding: "utf8",
        input: JSON.stringify({ merchants, keys: KEYS, responses }),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          PYTHONPATH: join(ROOT, "src"),
          PYTHONIOENCODING: "utf-8",
          CASHU_TESTING: "1",
          CASHU_DATA_DIR: data,
          CASHU_WORKSPACES_DIR: join(home, "workspaces"),
          CASHU_LEGACY_DATA_DIR: join(home, "legacy"),
          CASHU_LAUNCH_AGENTS_DIR: join(home, "agents"),
        },
      },
    );
    if (child.status !== 0) throw new Error(`synthetic Python cloud oracle exit ${child.status}`);
    return JSON.parse(child.stdout) as {
      requests: { url: string; headers: Record<string, string>; body: string }[];
      timeouts: number[];
      answers: Record<string, { category: string; confidence: number }>;
      failed_batches: number;
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

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
  it.each(CASES)("$name", async ({ count, responses }) => {
    const merchants = eligible(count);
    expect(merchants).toHaveLength(count);
    const oracle = python(merchants, responses);
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
