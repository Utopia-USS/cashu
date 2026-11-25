import { tiered } from "../../vitest.tiers.ts";

// Transport tests inject fetch; accidental real network access is refused before egress.
export default tiered({ setupFiles: ["./src/testing/noNetwork.setup.ts"] });
