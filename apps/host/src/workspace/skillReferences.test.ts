import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { skillReferenceCopies } from "./skillReferences.js";

const REPO = resolve(import.meta.dirname, "../../../..");

test("every skill reference copy is current (run pnpm --filter @cashu/host skills:sync)", () => {
  const copies = skillReferenceCopies(REPO);
  expect(copies.length).toBeGreaterThan(20);
  const stale = copies
    .filter(({ path, text }) => {
      const target = join(REPO, path);
      return !existsSync(target) || readFileSync(target, "utf8") !== text;
    })
    .map(({ path }) => path);
  expect(stale).toEqual([]);
});
