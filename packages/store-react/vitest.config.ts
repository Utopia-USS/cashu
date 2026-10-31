import { tiered } from "../../vitest.tiers.ts";

// Hooks render under jsdom (renderHook / render from @testing-library/react) against real in-memory
// stores on better-sqlite3; the port tests use Node's MessageChannel.
export default tiered({ environment: "jsdom" });
