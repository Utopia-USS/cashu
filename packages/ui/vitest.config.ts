import { tiered } from "../../vitest.tiers.ts";

// The DOM side: geometry / scene unit tests and the web render tests (jsdom). The native render tests
// (*.native.test.tsx) run under jest-expo (jest.config.cjs).
export default tiered({ environment: "jsdom", exclude: ["**/*.native.test.tsx"] });
