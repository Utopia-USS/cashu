import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeLanguageSource } from "./language.js";

const dir = () => mkdtempSync(join(tmpdir(), "cashu-lang-"));

describe("nodeLanguageSource (core/i18n.py order)", () => {
  it("reads CASHU_LANG, the stored choice and the OS separately", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ language: "pl", other: 1 }));
    const s = nodeLanguageSource({
      env: { CASHU_LANG: "en", LANG: "pl_PL.UTF-8" },
      dataDir: d,
      platform: "linux",
    });
    expect([s.environmentLanguage(), s.storedLanguage(), s.osLanguage()]).toEqual([
      "en",
      "pl",
      "pl_PL.UTF-8",
    ]);
  });

  it("treats a missing or malformed settings file as no choice", () => {
    const d = dir();
    expect(nodeLanguageSource({ env: {}, dataDir: d }).storedLanguage()).toBeNull();
    writeFileSync(join(d, "settings.json"), "[1]");
    expect(nodeLanguageSource({ env: {}, dataDir: d }).storedLanguage()).toBeNull();
    expect(nodeLanguageSource({ env: {}, dataDir: undefined }).storedLanguage()).toBeNull();
  });

  it("takes the first supported AppleLanguages entry on macOS before the locale variables", () => {
    let calls = 0;
    const s = nodeLanguageSource({
      env: { LANG: "en_US.UTF-8" },
      dataDir: undefined,
      platform: "darwin",
      appleLanguages: () => {
        calls += 1;
        return '(\n    "de-DE",\n    "pl-PL",\n    "en-US"\n)\n';
      },
    });
    expect(s.osLanguage()).toBe("pl-PL");
    expect(s.osLanguage()).toBe("pl-PL");
    expect(calls).toBe(1);
  });

  it("returns the first set locale variable as is, like Python", () => {
    const s = nodeLanguageSource({
      env: { LC_ALL: "", LC_MESSAGES: "de_DE", LANG: "pl_PL" },
      dataDir: undefined,
      platform: "linux",
    });
    expect(s.osLanguage()).toBe("de_DE");
  });
});
