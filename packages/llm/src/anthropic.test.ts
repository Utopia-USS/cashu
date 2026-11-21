import { budget, D } from "@cashu/domain";
import { describe, expect, it, vi } from "vitest";
import { AnthropicClassifier } from "./anthropic.js";
import {
  ClassifierAuthorityLost,
  type ClassifierDiagnostic,
  type ClassifierTransportContext,
  type CloudCredentials,
  type CurrentCloudConfig,
  type ReviewedCloudConsent,
} from "./ports.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const KEYS = ["groceries", "fuel"];

function merchants(count = 1): budget.CloudMerchant[] {
  return budget.cloudMerchants(
    Array.from({ length: count }, (_, i) => ({
      amount: D("-4321.98"),
      counterpartyName: `SKLEP UNIKAT ${String(i).padStart(2, "0")}`,
      counterpartyIban: null,
      reference: null,
      description: "PŁATNOŚĆ KARTĄ",
      isInternalTransfer: false,
      source: "default",
    })),
  );
}

const reply = (results: unknown = [{ id: "m0", category: "groceries", confidence: 0.8 }]) =>
  new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ results }) }] }));

function fixture() {
  const state = {
    authority: true,
    input: true,
    consent: true,
    config: true,
    key: "synthetic-key" as string | null,
  };
  const controller = new AbortController();
  const diagnostics: ClassifierDiagnostic[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply());
  const context: ClassifierTransportContext = {
    vault: "synthetic-vault",
    isHolder: () => state.authority,
    isInputCurrent: () => state.input,
    fetch,
    signal: controller.signal,
    onDiagnostic: (event) => diagnostics.push(event),
  };
  const consent: ReviewedCloudConsent = {
    vault: context.vault,
    riskCopy: "merchant-name-residual-v1",
    isCurrent: () => state.consent,
  };
  const apiKey = vi.fn(async (_vault: string) => state.key);
  const credentials: CloudCredentials = { apiKey };
  const config: CurrentCloudConfig = {
    model: "synthetic-model",
    endpoint: ENDPOINT,
    isCurrent: () => state.config,
  };
  const make = () => new AnthropicClassifier(context, consent, credentials, config);
  return {
    state,
    controller,
    diagnostics,
    fetch,
    context,
    consent,
    credentials,
    config,
    apiKey,
    make,
  };
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("missing synthetic request body");
  return JSON.parse(init.body);
}

describe("injected branded cloud transport", () => {
  it("retains the distinct branded API and sends only the existing merchant payload to the fixed endpoint", async () => {
    const f = fixture();
    const input = merchants();
    expect(input).toHaveLength(1);
    const expected = budget.anthropicMerchantBatches(input, KEYS, { model: "synthetic-model" })[0];
    if (!expected || !("body" in expected)) throw new Error("missing synthetic domain batch");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const result = await f.make().classifyCloudMerchants(input, KEYS);
      expect(result).toEqual({
        ok: true,
        answers: new Map([[input[0], { category: "groceries", confidence: 0.8 }]]),
      });
      const [url, init] = f.fetch.mock.calls[0] ?? [];
      expect(url).toBe(ENDPOINT);
      expect(init?.redirect).toBe("manual");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-key");
      expect(bodyOf(init)).toEqual(expected.body);
      expect(timeout).toHaveBeenCalledWith(60_000);
      expect(JSON.stringify(bodyOf(init))).not.toContain("4321.98");
      expect(JSON.stringify(bodyOf(init))).not.toContain("PŁATNOŚĆ KARTĄ");
      expect(f.apiKey).toHaveBeenCalledWith("synthetic-vault");
      expect(f.diagnostics).toEqual([]);
      expect("classifyMerchants" in f.make()).toBe(false);
      expect("classifyTransactions" in f.make()).toBe(false);
    } finally {
      timeout.mockRestore();
    }
  });

  it("requires matching reviewed capabilities at the actual constructor boundary", () => {
    const f = fixture();
    expect(
      () =>
        new AnthropicClassifier(
          f.context,
          { ...f.consent, vault: "other-vault" },
          f.credentials,
          f.config,
        ),
    ).toThrow(ClassifierAuthorityLost);
    expect(() => {
      // @ts-expect-error Missing consent is rejected at the runtime boundary too.
      new AnthropicClassifier(f.context, undefined, f.credentials, f.config);
    }).toThrow(ClassifierAuthorityLost);
    expect(() => {
      // @ts-expect-error Required credential capability cannot be omitted by a JS caller.
      new AnthropicClassifier(f.context, f.consent, undefined, f.config);
    }).toThrow(ClassifierAuthorityLost);
    expect(f.apiKey).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.anthropic.com.evil/v1/messages",
    `${ENDPOINT}?key=secret`,
    "http://127.0.0.1/messages",
  ])("refuses an unapproved endpoint before any credential lookup: %s", (endpoint) => {
    const f = fixture();
    expect(
      () => new AnthropicClassifier(f.context, f.consent, f.credentials, { ...f.config, endpoint }),
    ).toThrow("invalid cloud classifier configuration");
    expect(f.apiKey).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("retains prototype capability methods and their original private receivers", async () => {
    const f = fixture();
    class Consent implements ReviewedCloudConsent {
      readonly vault = f.context.vault;
      readonly riskCopy = "merchant-name-residual-v1" as const;
      #current = true;
      isCurrent() {
        return this.#current;
      }
    }
    class Credentials implements CloudCredentials {
      #key = "synthetic-key";
      async apiKey() {
        return this.#key;
      }
    }
    class Config implements CurrentCloudConfig {
      readonly model = "synthetic-model";
      readonly endpoint = ENDPOINT;
      #current = true;
      isCurrent() {
        return this.#current;
      }
    }
    const client = new AnthropicClassifier(
      f.context,
      new Consent(),
      new Credentials(),
      new Config(),
    );
    expect((await client.classifyCloudMerchants(merchants(), KEYS)).ok).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("captures immutable model/endpoint and parser inputs across awaits", async () => {
    const f = fixture();
    const config = { ...f.config };
    const client = new AnthropicClassifier(f.context, f.consent, f.credentials, config);
    config.endpoint = "https://unapproved.invalid/";
    config.model = "changed-model";
    const keys = [...KEYS];
    f.apiKey.mockImplementation(async () => {
      keys.push("invented");
      return "synthetic-key";
    });
    f.fetch.mockImplementation(async () =>
      reply([{ id: "m0", category: "invented", confidence: 5 }]),
    );
    const result = await client.classifyCloudMerchants(merchants(), keys);
    expect(f.fetch.mock.calls[0]?.[0]).toBe(ENDPOINT);
    expect(bodyOf(f.fetch.mock.calls[0]?.[1]).model).toBe("synthetic-model");
    if (!result.ok) throw new Error("synthetic response refused");
    expect([...result.answers.values()]).toEqual([{ category: "other", confidence: 1 }]);
  });

  it("makes no credential lookup or request for empty input", async () => {
    const f = fixture();
    expect(await f.make().classifyCloudMerchants([], KEYS)).toEqual({ ok: false, reason: "empty" });
    expect(f.apiKey).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["null", "throws"])("stops with no_api_key when credential lookup %s", async (mode) => {
    const f = fixture();
    f.apiKey.mockImplementation(async () => {
      if (mode === "throws") throw new Error("secret credential detail");
      return null;
    });
    expect(await f.make().classifyCloudMerchants(merchants(41), KEYS)).toEqual({
      ok: false,
      reason: "no_api_key",
    });
    expect(f.apiKey).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.diagnostics).toEqual([{ backend: "anthropic", reason: "no_api_key" }]);
  });

  it("batches40, restarts local ids and keeps successes around an HTTP failure", async () => {
    const f = fixture();
    const input = merchants(81);
    expect(input).toHaveLength(81);
    f.fetch
      .mockResolvedValueOnce(reply())
      .mockResolvedValueOnce(new Response("private response", { status: 503 }))
      .mockResolvedValueOnce(reply());
    const result = await f.make().classifyCloudMerchants(input, KEYS);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.apiKey).toHaveBeenCalledTimes(3);
    expect(f.diagnostics).toEqual([{ backend: "anthropic", reason: "unreachable" }]);
    if (!result.ok) throw new Error("successful synthetic batches discarded");
    expect([...result.answers.keys()]).toEqual([input[0], input[80]]);
  });

  it("discards prior successes when credentials disappear before the next batch", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () => {
      f.state.key = null;
      return reply();
    });
    expect(await f.make().classifyCloudMerchants(merchants(41), KEYS)).toEqual({
      ok: false,
      reason: "no_api_key",
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["authority", "input", "consent", "config", "cancel"] as const)(
    "refuses lost %s before requests and after credential/fetch/body awaits",
    async (guard) => {
      for (const stage of ["before", "credentials", "fetch", "body"] as const) {
        const f = fixture();
        const revoke = () => {
          if (guard === "cancel") f.controller.abort();
          else f.state[guard] = false;
        };
        if (stage === "before") revoke();
        if (stage === "credentials")
          f.apiKey.mockImplementation(async () => {
            revoke();
            return "synthetic-key";
          });
        f.fetch.mockImplementation(async () => {
          if (stage === "fetch") revoke();
          const response = reply();
          if (stage === "body")
            vi.spyOn(response, "text").mockImplementation(async () => {
              revoke();
              return "{}";
            });
          return response;
        });
        await expect(f.make().classifyCloudMerchants(merchants(41), KEYS)).rejects.toBeInstanceOf(
          ClassifierAuthorityLost,
        );
        expect(f.fetch).toHaveBeenCalledTimes(
          stage === "before" || stage === "credentials" ? 0 : 1,
        );
      }
    },
  );

  it.each([
    [
      "redirect",
      () =>
        new Response("private redirect body", {
          status: 307,
          headers: { location: "https://unapproved.invalid/" },
        }),
      "unreachable",
    ],
    ["invalid JSON", () => new Response("private malformed body"), "malformed"],
    ["invalid reply", () => new Response(JSON.stringify({ content: [] })), "malformed"],
  ] as const)("keeps %s failures value-free", async (_name, response, reason) => {
    const f = fixture();
    f.fetch.mockImplementation(async () => response());
    expect(await f.make().classifyCloudMerchants(merchants(), KEYS)).toEqual({ ok: false, reason });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.diagnostics).toEqual([{ backend: "anthropic", reason }]);
    expect(JSON.stringify(f.diagnostics)).not.toMatch(/private|synthetic-key|SKLEP/);
  });
});
