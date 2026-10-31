import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFiles, REPO_ROOT, readRepoFile, TEST_FILE } from "../repo.ts";
import { componentExports, storiedComponents } from "./stories.ts";

describe("storiedComponents (detector)", () => {
  it("reads the component of CSF metas", () => {
    const story =
      'const meta = { title: "Values/Money", component: Money } satisfies Meta<typeof Money>;';
    expect([...storiedComponents([story])]).toEqual(["Money"]);
  });
});

const UI_INDEX = "packages/ui/src/index.ts";
const uiExports = componentExports(UI_INDEX);

describe("guard: story coverage", () => {
  it.skipIf(uiExports.length === 0)(
    existsSync(join(REPO_ROOT, UI_INDEX))
      ? `every packages/ui component export has a story (${uiExports.length} exports)`
      : "every packages/ui component export has a story - SKIPPED: packages/ui has no components yet; the check turns on with the first export",
    () => {
      const stories = listFiles(["packages/ui"], /\.stories\.tsx$/).map(readRepoFile);
      const covered = storiedComponents(stories);
      const missing = uiExports.filter((n) => !covered.has(n));
      expect(
        missing,
        `packages/ui exports without a story (add <Name>.stories.tsx with \`component: <Name>\`, every variant and state):\n${missing.join("\n")}`,
      ).toEqual([]);
    },
  );

  const views = listFiles(["apps"], /View\.tsx$/).filter((f) => !TEST_FILE.test(f));

  it(`every app View has a sibling story with fake state (${views.length} Views)`, () => {
    const missing = views.filter(
      (v) => !existsSync(join(REPO_ROOT, v.replace(/\.tsx$/, ".stories.tsx"))),
    );
    expect(
      missing,
      `Views without <Name>View.stories.tsx (one story per screen phase: empty, ready, setupRequired, privacy mode):\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
