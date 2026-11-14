import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { listFiles, REPO_ROOT } from "../repo.ts";
import { catalogEntries, catalogProblems, isCatalog, pluralCategories } from "./catalogs.ts";

describe("catalogProblems (detector)", () => {
  it("accepts a complete catalog with functions and plurals", () => {
    const ok = {
      title: { pl: "Wydatki", en: "Spending" },
      count: { pl: (n: number) => `${n} pozycji`, en: (n: number) => `${n} items` },
      txns: {
        pl: {
          one: "# transakcja",
          few: "# transakcje",
          many: "# transakcji",
          other: "# transakcji",
        },
        en: { one: "# transaction", other: "# transactions" },
      },
    };
    expect(isCatalog(ok)).toBe(true);
    expect(catalogProblems("ok", ok)).toEqual([]);
  });

  it("reports a missing language, an arity mismatch and missing Polish plural forms", () => {
    const bad = {
      onlyPl: { pl: "Tylko polski" },
      arity: { pl: (a: string) => a, en: (a: string, b: string) => a + b },
      plural: { pl: { one: "#", other: "#" }, en: { one: "#", other: "#" } },
    };
    expect(catalogProblems("bad", bad)).toEqual([
      "bad.onlyPl: has pl, needs exactly pl and en",
      "bad.arity: pl is function/1 but en is function/2",
      'bad.plural.pl: plural is missing few, many (Intl.PluralRules("pl") needs few / many / one / other)',
    ]);
  });

  it("reads a runtime catalog through the raw entries it keeps", () => {
    const entries = { save: { pl: "Zapisz", en: "" } };
    const runtime = Object.defineProperty({ save: "Zapisz" }, Symbol.for("cashu.catalog.entries"), {
      value: entries,
    });
    expect(isCatalog(runtime)).toBe(false);
    expect(catalogEntries(runtime)).toBe(entries);
    expect(catalogProblems("rt", catalogEntries(runtime) as Record<string, unknown>)).toEqual([
      "rt.save.en: empty text",
    ]);
  });

  it("knows the plural categories of both UI languages", () => {
    expect(pluralCategories("pl")).toEqual(["few", "many", "one", "other"]);
    expect(pluralCategories("en")).toEqual(["one", "other"]);
  });
});

describe("guard: PL / EN catalog parity", () => {
  const files = listFiles(["packages", "apps"], /(^|\/)([\w.-]+\.)?strings\.ts$/);

  it(`every catalog entry exists in Polish and English (${files.length} catalog files)`, async () => {
    const problems: string[] = [];
    for (const file of files) {
      const mod = (await import(pathToFileURL(join(REPO_ROOT, file)).href)) as Record<
        string,
        unknown
      >;
      for (const [name, value] of Object.entries(mod)) {
        const raw = catalogEntries(value);
        if (isCatalog(raw)) problems.push(...catalogProblems(`${file}:${name}`, raw));
      }
    }
    expect(problems, `Catalog entries out of parity:\n${problems.join("\n")}`).toEqual([]);
  });
});
