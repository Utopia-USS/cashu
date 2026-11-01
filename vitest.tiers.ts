// The two test tiers of every workspace package (rule: tools/claude-dev/skills/cashu-ts-architecture/
// references/testing.md, "Test tiers"). A package's `vitest.config.ts` is `export default tiered()`.
//
//   default tier     `pnpm turbo run test`            every `*.test.ts(x)` except the exhaustive ones
//   exhaustive tier  `pnpm test:exhaustive`           only `*.exhaustive.test.ts(x)`, CASHU_TEST_TIER=exhaustive
//
// The per-test timeout is vitest's 5 s in both tiers: an exhaustive suite is split into small tests
// (one per Unicode plane, per slice of vectors, per seed), never given a longer budget.
import { configDefaults, defineProject, type TestProjectInlineConfiguration } from "vitest/config";

/** File name marker of the exhaustive tier. */
export const EXHAUSTIVE_GLOB = "**/*.exhaustive.test.{ts,tsx}";

type Options = NonNullable<TestProjectInlineConfiguration["test"]>;

/** The vitest project of one package for the tier named by `CASHU_TEST_TIER` (default: the fast tier). */
export function tiered(options: Options = {}) {
  const exhaustive = process.env.CASHU_TEST_TIER === "exhaustive";
  return defineProject({
    test: {
      ...options,
      // Keep dependency exclusions in both tiers even when a package adds platform exclusions.
      // Otherwise exhaustive discovery follows workspace links into another package's tests.
      exclude: [
        ...configDefaults.exclude,
        ...(options.exclude ?? []),
        ...(exhaustive ? [] : [EXHAUSTIVE_GLOB]),
      ],
      ...(exhaustive ? { include: [EXHAUSTIVE_GLOB] } : {}),
    },
  });
}
