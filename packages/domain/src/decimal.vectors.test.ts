import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT,
  Decimal,
  type DecimalContext,
  DecimalError,
  decimalKey,
  floatRepr,
  formatFloat,
  makeContext,
  type Rounding,
  roundFloat,
  roundFloatToInt,
} from "./decimal.js";
import { loadVectors, Mismatches, outcome } from "./testing/vectors.js";

const decimalError = (error: unknown) => (error instanceof DecimalError ? error.signal : null);
const run = <T>(fn: () => T) => outcome(fn, decimalError);
const str = (fn: () => Decimal) => run(() => fn().toString());

function ctxOf(spec: unknown): DecimalContext {
  const [prec, rounding, Emin, Emax] = spec as [number, Rounding, number, number];
  return makeContext({ prec, rounding, Emin, Emax });
}

function floatOf(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe("decimal vectors (parity/python/vectors.py)", () => {
  it("parses like Decimal(text) and prints like str(Decimal)", () => {
    const m = new Mismatches();
    for (const [text, expected, sign, digits, exp] of loadVectors("decimal-parse").rows) {
      const got = run(() => {
        const d = Decimal.parse(text as string);
        return [d.toString(), d.sign, d.digits, d.exp];
      });
      const want = typeof expected === "string" ? [expected, sign, digits, exp] : expected;
      m.check(JSON.stringify(text), got, want);
    }
    expect(m.items, m.report()).toEqual([]);
  });

  it("formats, decimal_key, int(), float()", () => {
    const m = new Mismatches();
    const [header, ...rows] = loadVectors("decimal-format").rows;
    const specs = (header as [string, string[]])[1];
    for (const [text, key, asInt, asFloat, formatted] of rows) {
      const d = Decimal.parse(text as string);
      m.check(`str ${text}`, d.toString(), text);
      m.check(`decimal_key ${text}`, decimalKey(d), key);
      m.check(`int ${text}`, d.toBigInt().toString(), asInt);
      m.check(`float ${text}`, floatRepr(d.toFloat()), asFloat);
      specs.forEach((spec, i) => {
        m.check(
          `format ${text} ${spec}`,
          d.format(spec, DEFAULT_CONTEXT),
          (formatted as string[])[i],
        );
      });
    }
    expect(m.items, m.report()).toEqual([]);
  });

  it("add / sub / mul / div in every context", () => {
    const m = new Mismatches();
    for (const [op, spec, a, b, expected] of loadVectors("decimal-arith").rows) {
      const ctx = ctxOf(spec);
      const x = Decimal.parse(a as string);
      const y = Decimal.parse(b as string);
      const got = str(() => {
        switch (op) {
          case "add":
            return x.add(y, ctx);
          case "sub":
            return x.sub(y, ctx);
          case "mul":
            return x.mul(y, ctx);
          default:
            return x.div(y, ctx);
        }
      });
      m.check(`${op} ${JSON.stringify(spec)} ${a} ${b}`, got, expected);
    }
    expect(m.items, m.report()).toEqual([]);
  });

  it("unary ops, quantize, scaleb, to_integral_value, compare", () => {
    const m = new Mismatches();
    for (const row of loadVectors("decimal-unary").rows) {
      const [op, spec, a] = row as [string, unknown, string];
      const ctx = ctxOf(spec);
      const x = Decimal.parse(a);
      const label = `${op} ${JSON.stringify(spec)} ${JSON.stringify(row.slice(2, -1))}`;
      const expected = row[row.length - 1];
      let got: unknown;
      switch (op) {
        case "neg":
          got = str(() => x.neg(ctx));
          break;
        case "plus":
          got = str(() => x.plus(ctx));
          break;
        case "abs":
          got = str(() => x.abs(ctx));
          break;
        case "normalize":
          got = str(() => x.normalize(ctx));
          break;
        case "copy_abs":
          got = x.copyAbs().toString();
          break;
        case "copy_negate":
          got = x.copyNegate().toString();
          break;
        case "to_integral_value":
          got = str(() => x.toIntegralValue(row[3] as Rounding, ctx));
          break;
        case "scaleb":
          got = str(() => x.scaleb(row[3] as number, ctx));
          break;
        case "quantize":
          got = str(() => x.quantize(row[3] as number, row[4] as Rounding, ctx));
          break;
        case "compare":
          got = x.compare(Decimal.parse(row[3] as string));
          break;
        default:
          throw new Error(`unknown op ${op}`);
      }
      m.check(label, got, expected);
    }
    expect(m.items, m.report()).toEqual([]);
  });

  it("integer powers like libmpdec", () => {
    const m = new Mismatches();
    for (const [spec, base, n, expected] of loadVectors("decimal-pow").rows) {
      const ctx = ctxOf(spec);
      const got = str(() => Decimal.parse(base as string).pow(n as number, ctx));
      m.check(`pow ${JSON.stringify(spec)} ${base} ${n}`, got, expected);
    }
    expect(m.items, m.report()).toEqual([]);
  });

  it("Python floats: repr, Decimal(float), format, round", () => {
    const m = new Mismatches();
    const [header, ...rows] = loadVectors("floats").rows;
    const specs = (header as [string, string[]])[1];
    for (const [hex, repr, exact, formatted, rounded] of rows) {
      const x = floatOf(hex as string);
      m.check(`repr ${hex}`, floatRepr(x), repr);
      if (exact !== null) m.check(`Decimal(${repr})`, Decimal.fromFloat(x).toString(), exact);
      if (formatted !== null) {
        specs.forEach((spec, i) => {
          m.check(`format(${repr}, ${spec})`, formatFloat(x, spec), (formatted as string[])[i]);
        });
      }
      if (rounded !== null) {
        const want = rounded as string[];
        for (let n = 0; n <= 6; n++)
          m.check(`round(${repr}, ${n})`, floatRepr(roundFloat(x, n)), want[n]);
        m.check(`round(${repr})`, roundFloatToInt(x).toString(), want[7]);
      }
    }
    expect(m.items, m.report()).toEqual([]);
  });
});
