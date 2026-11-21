import { describe, expect, it } from "vitest";
import { listFiles, readRepoFile, TEST_FILE } from "../repo.ts";
import { CATALOG_FILE, catalogNames, declaredUiActions, uiActionUses } from "./uiActions.ts";

describe("ui action detectors", () => {
  it("reads the catalog array, typed declarations and useUiAction arguments", () => {
    expect(
      catalogNames("import { a } from './a.js';\nexport const UI_ACTIONS = [a, { id: 'x' }];"),
    ).toEqual(["a", "<{ id: 'x' }>"]);
    expect(
      declaredUiActions(
        [
          'export const a: UiAction<{ q: string }, unknown> = { id: "m.a" };',
          'const hidden: UiAction<void, void> = { id: "m.h" };',
          'export const notAction = { id: "m.n" };',
        ].join("\n"),
      ),
    ).toEqual(["a"]);
    expect(
      uiActionUses(
        [
          'import { signalsWatch as watch } from "@cashu/store/investments/signals-screen";',
          "const w = useUiAction(watch);",
          'const inline = useUiAction({ id: "x" });',
        ].join("\n"),
      ),
    ).toEqual([
      { line: 2, name: "signalsWatch", from: "@cashu/store/investments/signals-screen" },
      { line: 3, name: null, from: null },
    ]);
  });
});

describe("guard: every dispatchable UI action is in the catalog", () => {
  const catalog = new Set(catalogNames(readRepoFile(CATALOG_FILE)));

  it("the catalog lists only imported action constants", () => {
    expect([...catalog].filter((name) => name.startsWith("<"))).toEqual([]);
    expect(catalog.size).toBeGreaterThan(0);
  });

  it("every UiAction constant of @cashu/store is listed", () => {
    const declared = listFiles(["packages/store/src"], /\.ts$/)
      .filter((file) => !TEST_FILE.test(file))
      .flatMap((file) =>
        declaredUiActions(readRepoFile(file), file).map((name) => ({ file, name })),
      );
    expect(declared.length).toBeGreaterThan(0);
    expect(
      declared.filter((d) => !catalog.has(d.name)).map((d) => `${d.file}: ${d.name}`),
      `add these to ${CATALOG_FILE}`,
    ).toEqual([]);
  });

  it("every useUiAction argument of the desktop renderer is a listed store constant", () => {
    const uses = listFiles(["apps/desktop/renderer"], /\.tsx?$/)
      .filter((file) => !TEST_FILE.test(file))
      .flatMap((file) => uiActionUses(readRepoFile(file), file).map((use) => ({ file, ...use })));
    expect(uses.length).toBeGreaterThan(0);
    const bad = uses.filter(
      (use) => use.name === null || !use.from?.startsWith("@cashu/store") || !catalog.has(use.name),
    );
    expect(
      bad.map((use) => `${use.file}:${use.line} ${use.name ?? "(not an imported constant)"}`),
      `useUiAction takes a @cashu/store UiAction constant listed in ${CATALOG_FILE}`,
    ).toEqual([]);
  });
});
