import { tiered } from "../../vitest.tiers.ts";

export default tiered({
  // The Playwright specs under e2e/ run with `pnpm e2e`, not here.
  include: ["src/**/*.test.ts"],
  testTimeout: 20_000,
});
