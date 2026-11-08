import { afterEach, describe, expect, it } from "vitest";
import { lang, setLanguageForTests } from "./lang.js";
import {
  type BackendLanguageSource,
  createBackendI18n,
  createTranslator,
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

describe("parseLang", () => {
  it.each([
    ["en-GB", "en"],
    ["pl_PL.UTF-8", "pl"],
    [" EN_us.UTF-8 ", "en"],
    ["de", null],
    ["", null],
    ["polish", null],
    [null, null],
    [1, null],
    [{ language: "pl" }, null],
  ])("parseLang(%j) = %s", (value, expected) => {
    expect(parseLang(value)).toBe(expected);
  });
});

describe("translators", () => {
  it("pin their own language without changing the enclosing run or the UI", () => {
    setLanguageForTests("pl");
    const outer = createTranslator("pl");
    const inner = createTranslator("en");
    expect(inner.tr(expense)).toBe("Expenses");
    expect(outer.tr(expense)).toBe("Wydatki");
    expect(lang()).toBe("pl");
    expect(tr(expense)).toBe("Wydatki");
  });

  it("return the selected generic value as-is without translating persisted data or codes", () => {
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

describe("backend language", () => {
  it("resolves environment, stored choice, OS, then English, looking the OS up once", () => {
    const { source, state } = settings();
    let lookups = 0;
    const backend = createBackendI18n({
      ...source,
      osLanguage: () => {
        lookups += 1;
        return state.os;
      },
    });
    state.os = "pl";
    expect(backend.appLanguage()).toBe("pl");
    state.stored = "en";
    expect(backend.appLanguage()).toBe("en");
    state.environment = "pl_PL.UTF-8";
    expect(backend.appLanguage()).toBe("pl");
    state.environment = "de";
    expect(backend.appLanguage()).toBe("en");
    state.stored = null;
    state.os = null;
    expect(backend.appLanguage()).toBe("pl");
    expect(lookups).toBe(1);
    expect(createBackendI18n(source).appLanguage()).toBe("en");
  });

  it("falls back to English when the settings and OS adapters cannot read", () => {
    const { source } = settings();
    const fail = () => {
      throw new Error("unavailable");
    };
    const backend = createBackendI18n({ ...source, storedLanguage: fail, osLanguage: fail });
    expect(backend.appLanguage()).toBe("en");
    expect(backend.forRequest("pl").tr(expense)).toBe("Wydatki");
    expect(backend.appLanguage()).toBe("en");
  });

  it("takes only the first raw request header, remembers a valid one best effort", () => {
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
    state.environment = "en";
    // A failed write never drops the request; the next valid request retries it.
    expect(backend.forRequest("pl").tr(expense)).toBe("Wydatki");
    expect(state.stored).toBeNull();
    expect(backend.forRequest(["pl", "en"]).language).toBe("pl");
    expect(state.writes).toEqual(["pl"]);
    // A comma list is one invalid value, never split; invalid or missing headers write nothing.
    for (const header of ["pl, en", ["de", "pl"], "", undefined, 1]) {
      expect(backend.forRequest(header).language).toBe("en");
    }
    backend.forRequest("pl");
    expect(state.writes).toEqual(["pl"]);
  });
});
