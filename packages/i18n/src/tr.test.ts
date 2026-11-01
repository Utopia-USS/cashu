import { afterEach, describe, expect, it } from "vitest";
import { lang, setLanguageForTests } from "./lang.js";
import { enCount, plCount } from "./plural.js";
import { REQUEST_HEADER_VECTORS } from "./testing/requestHeaders.js";
import {
  type BackendLanguageSource,
  createBackendI18n,
  createTranslator,
  LANG_ENV,
  LANG_HEADER,
  parseLang,
  tr,
} from "./tr.js";

const expense = { pl: "Wydatki", en: "Expenses" };

function settings() {
  const state: { environment: unknown; stored: unknown; os: unknown; writes: string[] } = {
    environment: null,
    stored: null,
    os: null,
    writes: [],
  };
  const source: BackendLanguageSource = {
    environmentLanguage: () => state.environment,
    storedLanguage: () => state.stored,
    osLanguage: () => state.os,
    rememberLanguage: (language) => {
      state.writes.push(language);
      state.stored = language;
    },
  };
  return { state, source, backend: createBackendI18n(source) };
}

afterEach(() => setLanguageForTests("en"));

describe("Python tests/test_i18n.py", () => {
  // test_parse_lang
  it.each([
    ["en-GB", "en"],
    ["pl_PL.UTF-8", "pl"],
    ["de", null],
    [null, null],
    [" EN_us.UTF-8 ", "en"],
    ["PL.utf8", "pl"],
    ["", null],
    ["polish", null],
    [1, null],
    [true, null],
    [{ language: "pl" }, null],
    [["pl"], null],
    ["\u001cpl\u0085", "pl"],
    ["\ufeffen", null],
    ["pl\ufeff", null],
  ])("parse_lang(%j) = %s", (value, expected) => {
    expect(parseLang(value)).toBe(expected);
  });

  // test_tests_pin_polish_and_use_language_switches: explicit lexical context replaces ContextVar.
  it("pins the run without changing the enclosing run or the UI", () => {
    setLanguageForTests("pl");
    const outer = createTranslator("pl");
    expect(tr(expense)).toBe("Wydatki");
    expect(outer.tr(expense)).toBe("Wydatki");
    const inner = createTranslator("en");
    expect(inner.tr(expense)).toBe("Expenses");
    expect(outer.tr(expense)).toBe("Wydatki");
    expect(lang()).toBe("pl");
    expect(tr(expense)).toBe("Wydatki");
  });

  // test_app_language_order
  it("resolves environment, stored dashboard choice, OS, then English in that order", () => {
    const { source, state, backend } = settings();
    state.os = "pl";
    expect(backend.appLanguage()).toBe("pl");
    backend.forRequest("en");
    expect(state.stored).toBe("en");
    expect(backend.appLanguage()).toBe("en");
    state.environment = "pl_PL.UTF-8";
    expect(backend.appLanguage()).toBe("pl");
    state.environment = "de";
    expect(backend.appLanguage()).toBe("en");
    state.stored = null;
    expect(backend.appLanguage()).toBe("pl");
    state.os = null;
    // Python monkeypatches os_language itself here, replacing its cached function. A fresh source
    // context models that replacement; the existing context deliberately keeps its cached OS value.
    expect(createBackendI18n(source).appLanguage()).toBe("en");
  });

  // test_middleware_sets_the_request_language (sync)
  it("renders sync requests and remembers the last valid header for headerless work", () => {
    const { backend } = settings();
    const endpoint = (header?: string) => ({ text: backend.forRequest(header).tr(expense) });
    expect(LANG_HEADER).toBe("x-cashu-lang");
    expect(LANG_ENV).toBe("CASHU_LANG");
    expect(endpoint("pl")).toEqual({ text: "Wydatki" });
    expect(endpoint("en")).toEqual({ text: "Expenses" });
    expect(endpoint()).toEqual({ text: "Expenses" });
    expect(backend.appLanguage()).toBe("en");
  });

  // test_middleware_sets_the_request_language (async)
  it("renders async requests using their captured context", async () => {
    const { backend } = settings();
    const endpoint = async (header?: string) => {
      const context = backend.forRequest(header);
      await Promise.resolve();
      return { text: context.tr(expense) };
    };
    expect(await endpoint("pl")).toEqual({ text: "Wydatki" });
    expect(await endpoint("en")).toEqual({ text: "Expenses" });
    expect(await endpoint()).toEqual({ text: "Expenses" });
    expect(backend.appLanguage()).toBe("en");
  });

  // test_plurals: S33's helpers are shared by backend and UI.
  it("preserves the oracle's Polish and English plurals", () => {
    expect([1, 2, 5, 12, 22].map((n) => plCount(n, "sygnał", "sygnały", "sygnałów"))).toEqual([
      "1 sygnał",
      "2 sygnały",
      "5 sygnałów",
      "12 sygnałów",
      "22 sygnały",
    ]);
    expect(enCount(1, "signal", "signals")).toBe("1 signal");
    expect(enCount(3, "signal", "signals")).toBe("3 signals");
  });
});

describe("backend boundaries and request isolation", () => {
  it("memoizes the OS lookup while re-reading environment and stored choices", () => {
    const { source, state } = settings();
    let lookups = 0;
    const backend = createBackendI18n({
      ...source,
      osLanguage: () => {
        lookups += 1;
        return "pl";
      },
    });
    expect(backend.appLanguage()).toBe("pl");
    expect(backend.forRequest().language).toBe("pl");
    state.environment = "en";
    expect(backend.appLanguage()).toBe("en");
    state.environment = null;
    state.stored = "en";
    expect(backend.appLanguage()).toBe("en");
    state.stored = null;
    expect(backend.appLanguage()).toBe("pl");
    expect(lookups).toBe(1);
  });

  it("memoizes an unsupported OS language too", () => {
    const { source } = settings();
    let lookups = 0;
    const backend = createBackendI18n({
      ...source,
      osLanguage: () => {
        lookups += 1;
        return null;
      },
    });
    expect(backend.appLanguage()).toBe("en");
    expect(backend.forRequest().language).toBe("en");
    expect(lookups).toBe(1);
  });

  // Real Python LanguageMiddleware vectors, including invalid comma values vs duplicate raw lines.
  it.each(REQUEST_HEADER_VECTORS)("matches Python request headers: $name", (vector) => {
    const { state, backend } = settings();
    state.environment = vector.app;
    expect(backend.forRequest(vector.lines).language).toBe(vector.language);
    expect(state.writes).toEqual(vector.writes);
    if (vector.lines.length <= 1) {
      const single = settings();
      single.state.environment = vector.app;
      expect(single.backend.forRequest(vector.lines[0]).language).toBe(vector.language);
      expect(single.state.writes).toEqual(vector.writes);
    }
  });

  it("lets the request outrank the environment pin and ignores invalid headers without writing", () => {
    const { state, backend } = settings();
    state.environment = "pl";
    expect(backend.forRequest("en-GB").language).toBe("en");
    expect(backend.appLanguage()).toBe("pl");
    for (const header of [null, undefined, "de", "", 1, {}, [1], [["en"]]]) {
      expect(backend.forRequest(header).language).toBe("pl");
    }
    expect(state.writes).toEqual(["en"]);
  });

  it("skips repeated settings writes and canonicalizes a stored locale tag", () => {
    const { state, backend } = settings();
    state.stored = "en-GB";
    backend.forRequest("en");
    backend.forRequest("en-US");
    backend.forRequest("en");
    backend.forRequest("pl");
    backend.forRequest("pl");
    backend.forRequest("en");
    expect(state.writes).toEqual(["en", "pl", "en"]);
  });

  it("does not write settings already in the requested language", () => {
    const { state, backend } = settings();
    state.stored = "pl";
    backend.forRequest("pl");
    expect(state.writes).toEqual([]);
  });

  it("renders despite a failed write and retries persistence on the next request", () => {
    const { source, state } = settings();
    let attempts = 0;
    const backend = createBackendI18n({
      ...source,
      rememberLanguage: (language) => {
        attempts += 1;
        if (attempts === 1) throw new Error("read-only settings");
        source.rememberLanguage(language);
      },
    });
    expect(backend.forRequest("pl").tr(expense)).toBe("Wydatki");
    expect(state.stored).toBeNull();
    expect(backend.forRequest("pl").tr(expense)).toBe("Wydatki");
    expect(attempts).toBe(2);
    expect(state.stored).toBe("pl");
  });

  it("falls back safely when the settings and OS adapters cannot read", () => {
    const { source } = settings();
    const fail = () => {
      throw new Error("unavailable");
    };
    const backend = createBackendI18n({ ...source, storedLanguage: fail, osLanguage: fail });
    expect(backend.appLanguage()).toBe("en");
    expect(backend.forRequest("pl").tr(expense)).toBe("Wydatki");
    expect(backend.appLanguage()).toBe("en");
  });

  it("can repair unreadable settings when the write adapter still works", () => {
    const { source, state } = settings();
    const backend = createBackendI18n({
      ...source,
      storedLanguage: () => {
        throw new Error("malformed settings");
      },
    });
    expect(backend.forRequest("pl").language).toBe("pl");
    expect(state.writes).toEqual(["pl"]);
  });

  it("has independent settings locations and remember caches", () => {
    const left = settings();
    const right = settings();
    left.backend.forRequest("pl");
    right.backend.forRequest("en");
    expect(left.backend.appLanguage()).toBe("pl");
    expect(right.backend.appLanguage()).toBe("en");
    expect(left.state.writes).toEqual(["pl"]);
    expect(right.state.writes).toEqual(["en"]);
  });

  it("keeps overlapping opposite-language requests isolated through awaits and failures", async () => {
    const { backend } = settings();
    setLanguageForTests("en");
    const run = async (header: string) => {
      const context = backend.forRequest(header);
      const before = context.tr(expense);
      await Promise.resolve();
      try {
        await Promise.reject(new Error("synthetic request failure"));
      } catch {
        expect(context.tr(expense)).toBe(before);
      }
      return [before, context.tr(expense)];
    };
    expect(await Promise.all([run("pl"), run("en"), run("pl")])).toEqual([
      ["Wydatki", "Wydatki"],
      ["Expenses", "Expenses"],
      ["Wydatki", "Wydatki"],
    ]);
    expect(lang()).toBe("en");
  });

  // Pure prerequisite only. The Python MCP oracle also calls CashuMcp and labels.category;
  // that integration assertion waits for the S38 host, not this translator unit test.
  it("pins an explicit Polish run independently of an English worker and UI", async () => {
    const { state, backend } = settings();
    state.environment = "en";
    setLanguageForTests("en");
    const worker = createTranslator(backend.appLanguage());
    const mcp = createTranslator("pl");
    await Promise.resolve();
    expect(mcp.tr({ pl: "Pieniądze", en: "Money" })).toBe("Pieniądze");
    expect(worker.tr({ pl: "Pieniądze", en: "Money" })).toBe("Money");
    expect(lang()).toBe("en");
    expect(state.writes).toEqual([]);
  });

  it("returns the selected generic value as-is without translating persisted data or codes", () => {
    const stored = { code: "strategy.required", params: { key: "version" }, name: "Dom" };
    const english = { title: "Default", stored };
    const polish = { title: "Domyślny", stored };
    const variants = { pl: polish, en: english };
    expect(createTranslator("en").tr(variants)).toBe(english);
    expect(createTranslator("pl").tr(variants)).toBe(polish);
    expect(stored).toEqual({ code: "strategy.required", params: { key: "version" }, name: "Dom" });
    const render = createTranslator("en").tr({
      pl: (n: number) => `PL ${n}`,
      en: (n: number) => `EN ${n}`,
    });
    expect(render(3)).toBe("EN 3");
  });
});
