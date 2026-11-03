import { describe, expect, it } from "vitest";
import { OllamaClassifier } from "./ollama.js";
import {
  ClassifierAuthorityLost,
  type ClassifierDiagnostic,
  type ClassifierTransportContext,
} from "./ports.js";

function context(
  fetch: typeof globalThis.fetch,
  extras: Partial<ClassifierTransportContext> = {},
): ClassifierTransportContext {
  return {
    vault: "synthetic-vault",
    isHolder: () => true,
    isInputCurrent: () => true,
    fetch,
    signal: new AbortController().signal,
    ...extras,
  };
}

describe("OllamaClassifier", () => {
  it("rejects non-loopback endpoints before a request and captures options immutably", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    }) as typeof globalThis.fetch;
    expect(
      () =>
        new OllamaClassifier(context(fetch), {
          url: "https://example.test",
          model: "synthetic",
        }),
    ).toThrow("loopback");
    const options = { url: "http://127.0.0.1:11434", model: "synthetic" };
    const classifier = new OllamaClassifier(context(fetch), options);
    options.url = "https://example.test";
    options.model = "changed";
    expect(classifier.options).toEqual({ url: "http://127.0.0.1:11434", model: "synthetic" });
    await classifier.classifyMerchants(["invented merchant"], ["food"]);
    expect(calls).toBe(1);
  });

  it("refuses stale whole-vault input before a request and after a fetch", async () => {
    let current = false;
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      current = false;
      return new Response('{"message":{"content":"{}"}}');
    }) as typeof globalThis.fetch;
    const classifier = new OllamaClassifier(context(fetch, { isInputCurrent: () => current }), {
      url: "http://localhost:11434",
      model: "synthetic",
    });
    await expect(
      classifier.classifyMerchants(["invented merchant"], ["food"]),
    ).rejects.toBeInstanceOf(ClassifierAuthorityLost);
    expect(calls).toBe(0);
    current = true;
    await expect(
      classifier.classifyMerchants(["invented merchant"], ["food"]),
    ).rejects.toBeInstanceOf(ClassifierAuthorityLost);
    expect(calls).toBe(1);
  });

  it("reports only structured status and whitelisted parser position", async () => {
    const diagnostics: ClassifierDiagnostic[] = [];
    let status = 503;
    const fetch = (async () =>
      status === 503
        ? new Response(null, { status })
        : new Response('{"message":{"content":"{"}}')) as typeof globalThis.fetch;
    const classifier = new OllamaClassifier(
      context(fetch, { onDiagnostic: (event) => diagnostics.push(event) }),
      { url: "http://localhost:11434", model: "synthetic" },
    );
    await classifier.classifyMerchants(["invented merchant"], ["food"]);
    status = 200;
    await classifier.classifyMerchants(["invented merchant"], ["food"]);
    expect(diagnostics).toEqual([
      { backend: "ollama", reason: "unreachable", httpStatus: 503 },
      {
        backend: "ollama",
        reason: "malformed",
        parse: { kind: "expected_property_name", line: 1, column: 2, position: 1 },
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("invented merchant");
  });

  it("rejects invalid transaction batch sizes before constructing batches or making a request", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    }) as typeof globalThis.fetch;
    const classifier = new OllamaClassifier(context(fetch), {
      url: "http://localhost:11434",
      model: "synthetic",
    });
    for (const batchSize of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        classifier.classifyTransactions([], ["food"], new Map(), { batchSize }),
      ).rejects.toThrow(RangeError);
    }
    expect(calls).toBe(0);
  });

  it("retains prototype capability methods and their receiver", async () => {
    class Context implements ClassifierTransportContext {
      readonly vault = "synthetic-vault";
      readonly signal = new AbortController().signal;
      readonly fetch = (async () => new Response(null, { status: 503 })) as typeof globalThis.fetch;
      isHolder(vault: string) {
        return this.vault === vault;
      }
      isInputCurrent(vault: string) {
        return this.vault === vault;
      }
    }
    const classifier = new OllamaClassifier(new Context(), {
      url: "http://localhost:11434",
      model: "synthetic",
    });
    await expect(classifier.classifyMerchants(["invented merchant"], ["food"])).resolves.toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("treats a throwing currentness provider as lost authority before egress", async () => {
    let calls = 0;
    let throws = true;
    const fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    }) as typeof globalThis.fetch;
    const classifier = new OllamaClassifier(
      context(fetch, {
        isInputCurrent: () => {
          if (throws) {
            throws = false;
            throw new Error("synthetic provider failure");
          }
          return true;
        },
      }),
      { url: "http://localhost:11434", model: "synthetic" },
    );
    await expect(classifier.classifyMerchants(["invented merchant"], ["food"])).rejects.toBeInstanceOf(
      ClassifierAuthorityLost,
    );
    expect(calls).toBe(0);
  });
});
