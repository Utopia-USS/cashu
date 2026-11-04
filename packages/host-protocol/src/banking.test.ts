import { expect, it } from "vitest";
import { roleAllows } from "./roles.js";
import { NATIVE_BANKING_FEATURE, uiBankingAllowed } from "./banking.js";

it("admits only the two exact UI banking methods behind the current feature", () => {
  for (const method of ["native.banking.configure", "native.banking.consentUrl"]) {
    expect(uiBankingAllowed(method, 7, [NATIVE_BANKING_FEATURE])).toBe(true);
    expect(uiBankingAllowed(method, 6, [NATIVE_BANKING_FEATURE])).toBe(false);
    expect(roleAllows("ui", { t: "req", id: 1, method, params: {} })).toBe(true);
    expect(roleAllows("mcp", { t: "req", id: 1, method, params: {} })).toBe(false);
  }
  expect(uiBankingAllowed("native.banking.configure.extra", 7, [NATIVE_BANKING_FEATURE])).toBe(false);
  expect(roleAllows("ui", { t: "req", id: 1, method: "native.banking.configure.extra", params: {} })).toBe(false);
});
