import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@cashu/i18n scaffold", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("@cashu/i18n");
  });
});
