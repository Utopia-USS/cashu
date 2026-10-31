import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@cashu/domain scaffold", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("@cashu/domain");
  });
});
