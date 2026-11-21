import { describe, expect, it } from "vitest";
import { listFiles, readRepoFile, TEST_FILE } from "../repo.ts";
import { polishCodeLines } from "./hardcodedText.ts";

/** UI code whose Polish is data, not copy (repo-relative path -> reason). */
const ALLOWED: Record<string, string> = {
  "packages/ui-logic/src/core/messages.ts":
    "Polish labels of backend codes; in English the server's own English text is shown",
};

const CATALOG = /(^|\/)([\w.-]+\.)?strings\.ts$/;

describe("polishCodeLines (detector)", () => {
  it("flags Polish in code and skips comments", () => {
    const src = [
      "// Zapisz is a comment",
      "/* wielolinijkowy",
      "   komentarz */",
      'const a = "Zapisz zmiany";',
      'const b = "Save"; // zapis',
      "/** Polski opis */",
      'const c = { label: "Wyłącz" };',
    ].join("\n");
    expect(polishCodeLines(src)).toEqual([7]);
  });
});

describe("guard: no hardcoded Polish UI text outside catalogs", () => {
  const files = listFiles(
    ["packages/i18n/src", "packages/ui-logic/src", "packages/ui/src", "apps"],
    /\.tsx?$/,
  ).filter((f) => !TEST_FILE.test(f) && !CATALOG.test(f) && !(f in ALLOWED));

  it(`UI code keeps its copy in catalogs (${files.length} files)`, () => {
    const hits = files.flatMap((f) => polishCodeLines(readRepoFile(f)).map((l) => `${f}:${l}`));
    expect(
      hits,
      `Polish text outside a catalog (move it to a *.strings.ts entry, docs/agents/localization.md):\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
