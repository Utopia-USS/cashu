import { D } from "@cashu/domain";
import { PyFloat as SharedPyFloat } from "@cashu/store/genesis/verification";
import { describe, expect, it } from "vitest";
import { dumps, PyFloat, pyFloat } from "./output.ts";

describe("producer output", () => {
  it("uses the same float class as the portable migration verifier", () => {
    expect(PyFloat).toBe(SharedPyFloat);
    expect(pyFloat(0.1)).toBeInstanceOf(SharedPyFloat);
  });
  it("writes canonical JSON: sorted keys, compact, decimals as Python str()", () => {
    expect(dumps({ b: [D("1.50"), D("1E+1"), null], a: { y: true, x: "ż" } })).toBe(
      '{"a":{"x":"ż","y":true},"b":["1.50","1E+1",null]}\n',
    );
    expect(dumps(12n)).toBe("12\n");
  });

  it("refuses JS numbers (money is never a float)", () => {
    expect(() => dumps({ amount: 1.5 } as never)).toThrow(/not floats/);
  });

  it("writes wrapped floats like Python json.dumps (repr; NaN / Infinity as canon.py strings)", () => {
    expect(
      dumps([
        pyFloat(0.1),
        pyFloat(2),
        pyFloat(1e-5),
        pyFloat(-0),
        pyFloat(0.33779892754253094),
        pyFloat(Number.POSITIVE_INFINITY),
        pyFloat(Number.NEGATIVE_INFINITY),
        pyFloat(Number.NaN),
      ]),
    ).toBe('[0.1,2.0,1e-05,-0.0,0.33779892754253094,"Infinity","-Infinity","NaN"]\n');
  });
});
