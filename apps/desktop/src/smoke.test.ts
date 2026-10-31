import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@cashu/desktop scaffold", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("@cashu/desktop");
  });
});
