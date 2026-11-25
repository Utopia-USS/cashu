import { defineConfig } from "vitest/config";

// Root run across every workspace member (`pnpm test:all`); turbo runs each package's own `vitest run`.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
