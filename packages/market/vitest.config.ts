import { tiered } from "../../vitest.tiers.ts";

// Every test file runs after the network guard: real sockets and the global fetch throw.
export default tiered({ setupFiles: ["./src/testing/noNetwork.setup.ts"] });
