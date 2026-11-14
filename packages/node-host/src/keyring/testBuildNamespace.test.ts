import { describe, expect, it } from "vitest";
import { addressedService, enterTestBuildKeyringNamespace, testBuildService } from "./native.js";

// The switch is one-way and process wide: this file runs in its own module instance (vitest
// isolates test files), so flipping it here never reaches another test file.
describe("test-build keyring namespace", () => {
  const production = [
    `cashu.vault.v1.${"a".repeat(64)}`,
    `cashu.banking.v1.${"b".repeat(64)}`,
    `cashu.connectors.v1.${"c".repeat(64)}`,
    `cashu.classifier.v1.${"d".repeat(64)}`,
  ];

  it("addresses the production services unchanged without a test build", () => {
    for (const service of production) expect(addressedService(service)).toBe(service);
  });

  it("maps every service into a distinct, stable cashu-next-test.<hex> name in a test build", () => {
    enterTestBuildKeyringNamespace();
    const mapped = production.map(addressedService);
    for (const [index, name] of mapped.entries()) {
      expect(name).toMatch(/^cashu-next-test\.[0-9a-f]{32}$/);
      expect(name).toBe(testBuildService(production[index] as string));
      expect(addressedService(production[index] as string)).toBe(name);
    }
    expect(new Set(mapped).size).toBe(production.length);
    // Even a name that already looks like a test service is mapped, never passed through.
    const test = `cashu-next-test.${"0".repeat(32)}`;
    expect(addressedService(test)).not.toBe(test);
  });
});
