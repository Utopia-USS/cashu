import { beforeEach, describe, expect, it } from "vitest";
import { catalog } from "./catalog.js";
import {
  inEveryLang,
  installLanguageSource,
  intlLocale,
  type Lang,
  type LanguageSource,
  lang,
  pinnedLang,
  setLanguage,
} from "./lang.js";
import { tr } from "./tr.js";

function source(pin: string | null, tags: string[]): LanguageSource & { pins: (Lang | null)[] } {
  const pins: (Lang | null)[] = [];
  return { pins, pinned: () => pin, systemTags: () => tags, pin: (c) => pins.push(c) };
}

describe("language resolution: the Settings pin, else the OS list, else English", () => {
  beforeEach(() => installLanguageSource(source(null, [])));

  it("is English with neither a pin nor a supported OS language", () => {
    installLanguageSource(source(null, ["de-DE", "fr"]));
    expect(lang()).toBe("en");
    expect(intlLocale()).toBe("en-US");
  });

  it("takes the first supported OS language, and its English variant for Intl", () => {
    installLanguageSource(source(null, ["de-DE", "pl-PL", "en-GB"]));
    expect(lang()).toBe("pl");
    expect(intlLocale()).toBe("pl-PL");
    installLanguageSource(source(null, ["en_GB", "pl"]));
    expect(lang()).toBe("en");
    expect(intlLocale()).toBe("en-GB");
  });

  it("lets the pin win over the OS and ignores a pin it does not know", () => {
    installLanguageSource(source("pl", ["en-US"]));
    expect(pinnedLang()).toBe("pl");
    expect(lang()).toBe("pl");
    installLanguageSource(source("de", ["en-US"]));
    expect(pinnedLang()).toBeNull();
    expect(lang()).toBe("en");
  });

  it("treats a failing pin read as no pin", () => {
    installLanguageSource({
      pinned: () => {
        throw new Error("storage blocked");
      },
      systemTags: () => ["pl-PL"],
      pin: () => {},
    });
    expect(pinnedLang()).toBeNull();
    expect(lang()).toBe("pl");
  });

  it("hands a new pin to the source, which stores it and restarts the UI", () => {
    const s = source(null, ["pl-PL"]);
    installLanguageSource(s);
    setLanguage("en");
    expect(lang()).toBe("en");
    setLanguage(null);
    expect(s.pins).toEqual(["en", null]);
    expect(lang()).toBe("pl");
  });
});

describe("catalogs", () => {
  beforeEach(() => installLanguageSource(source(null, [])));

  it("read the language on every access, never at import", () => {
    const S = catalog({ save: { pl: "Zapisz", en: "Save" } });
    expect(S.save).toBe("Save");
    installLanguageSource(source("pl", []));
    expect(S.save).toBe("Zapisz");
    expect(tr({ pl: "tak", en: "yes" })).toBe("tak");
    expect(inEveryLang(() => S.save)).toEqual(["Zapisz", "Save"]);
    expect(lang()).toBe("pl");
  });

  it("keep their raw entries for the parity guard, out of sight of keys and spreads", () => {
    const entries = { save: { pl: "Zapisz", en: "Save" } };
    const S = catalog(entries);
    expect(Object.keys(S)).toEqual(["save"]);
    expect({ ...S }).toEqual({ save: "Save" });
    expect((S as Record<symbol, unknown>)[Symbol.for("cashu.catalog.entries")]).toBe(entries);
  });
});
