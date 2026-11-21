// The two test tiers of every workspace package (rule: tools/claude-dev/skills/cashu-ts-architecture/
// references/testing.md, "Test tiers"). A package's `vitest.config.ts` is `export default tiered()`.
//
//   default tier     `pnpm turbo run test`            every `*.test.ts(x)` except the exhaustive ones
//   exhaustive tier  `pnpm test:exhaustive`           only `*.exhaustive.test.ts(x)`, CASHU_TEST_TIER=exhaustive
//
// The per-test timeout is vitest's 5 s in both tiers: an exhaustive suite is split into small tests
// (one per Unicode plane, per slice of vectors, per seed), never given a longer budget. The one
// exception is a platform setting, not a test's: on Windows the default is `WINDOWS_TEST_TIMEOUT_MS`.
// A host test there pays for each start the data dir's owner-only ACL step (whoami, PowerShell and
// icacls, about 0.3 s; `windowsAcl.ts` says why the owner cannot be cached), and file and process work
// is far slower there overall: host tests that take 30-120 ms on macOS took 0.5-9 s on the
// windows-latest CI runner (CI run 3: three crossed 5 s). A real hang still fails, only later.
//
// Workers: a quarter of the cores per package, and the root `test` script runs at most 4 packages at once,
// so a full run keeps about one worker per core. Unbounded (turbo's 10 packages x vitest's cores - 1
// workers each) put ~150 processes on 10 cores and pushed sound tests past the 5 s timeout.
import { configDefaults, defineProject, type TestProjectInlineConfiguration } from "vitest/config";

/** The default per-test timeout on Windows (see the header); 5 s elsewhere. */
const WINDOWS_TEST_TIMEOUT_MS = 30_000;

/** File name marker of the exhaustive tier. */
export const EXHAUSTIVE_GLOB = "**/*.exhaustive.test.{ts,tsx}";

type Options = NonNullable<TestProjectInlineConfiguration["test"]>;

/** The vitest project of one package for the tier named by `CASHU_TEST_TIER` (default: the fast tier). */
export function tiered(options: Options = {}) {
  const exhaustive = process.env.CASHU_TEST_TIER === "exhaustive";
  return defineProject({
    test: {
      maxWorkers: "25%",
      ...(process.platform === "win32" ? { testTimeout: WINDOWS_TEST_TIMEOUT_MS } : {}),
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
