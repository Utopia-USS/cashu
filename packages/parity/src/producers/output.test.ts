import { D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { dumps } from "./output.ts";

describe("producer output", () => {
  it("writes canonical JSON: sorted keys, compact, decimals as Python str()", () => {
    expect(dumps({ b: [D("1.50"), D("1E+1"), null], a: { y: true, x: "ż" } })).toBe(
      '{"a":{"x":"ż","y":true},"b":["1.50","1E+1",null]}\n',
    );
    expect(dumps(12n)).toBe("12\n");
  });

  it("refuses JS numbers (money is never a float)", () => {
    expect(() => dumps({ amount: 1.5 } as never)).toThrow(/not floats/);
  });
});
