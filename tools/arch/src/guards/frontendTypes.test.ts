// The legacy SPA (frontend/, React 18) shares one pnpm workspace with React 19 apps. Libraries that ship
// .d.ts files importing "react" without depending on @types/react (recharts 2) get whichever @types/react
// pnpm hoisted into the virtual store, which flips to React 19's when the workspace changes and breaks every
// JSX element of the library in frontend/. The lockfile must link them to the SPA's own @types/react.
import { describe, expect, it } from "vitest";
import { readRepoFile } from "../repo.ts";

const manifest = JSON.parse(readRepoFile("frontend/package.json")) as {
  devDependencies?: Record<string, string>;
};
const typesRange = manifest.devDependencies?.["@types/react"] ?? "";
const typesMajor = /\d+/.exec(typesRange)?.[0];

/** Libraries with React typings in their .d.ts that frontend/ renders. */
const LIBRARIES = ["recharts"];

describe("guard: frontend libraries resolve the frontend's own @types/react", () => {
  it("frontend/ declares @types/react", () => {
    expect(typesMajor, "frontend/package.json needs an @types/react devDependency").toBeDefined();
  });

  const lock = readRepoFile("pnpm-lock.yaml");
  it.each(LIBRARIES)("%s", (name) => {
    const keys = lock
      .split("\n")
      .filter((l) => l.startsWith(`  ${name}@`) && l.endsWith("):"))
      .map((l) => l.trim());
    expect(keys.length, `pnpm-lock.yaml has no ${name} snapshot`).toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        key.includes(`(@types/react@${typesMajor}.`),
        `${key} must be linked to @types/react ${typesMajor}.x: add an optional @types/react peer for ${name} under packageExtensions in pnpm-workspace.yaml`,
      ).toBe(true);
    }
  });
});
