/**
 * Python `json.loads` for market responses: the JSON grammar plus Python's `NaN`, `Infinity` and
 * `-Infinity` literals, with a hook for numbers so a caller can keep their exact text (Python
 * `parse_float=Decimal`: NBP rates are exact decimals, never floats). Throws `PyJsonError` (Python
 * `ValueError`) on anything else.
 */

/** Python `json.JSONDecodeError` (a `ValueError`). */
export class PyJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PyJsonError";
  }
}

/** Turns one number literal into a value; `integer` is true for a literal without fraction or exponent. */
export type NumberReader = (text: string, integer: boolean) => unknown;

const asFloat: NumberReader = (text) => Number(text);

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const WS = /[ \t\n\r]*/y;

/** Parses `text` like Python `json.loads(text, parse_float=..., parse_int=...)` (both via `number`). */
export function parsePyJson(text: string, number: NumberReader = asFloat): unknown {
  let pos = 0;

  const fail = (what: string): never => {
    throw new PyJsonError(`${what} at char ${pos}`);
  };
  const skip = (): void => {
    WS.lastIndex = pos;
    WS.exec(text);
    pos = WS.lastIndex;
  };
  const literal = (word: string, value: unknown): unknown => {
    if (!text.startsWith(word, pos)) fail("Expecting value");
    pos += word.length;
    return value;
  };

  const parseString = (): string => {
    pos++; // opening quote
    let out = "";
    let chunk = pos;
    for (;;) {
      if (pos >= text.length) fail("Unterminated string");
      const ch = text.charCodeAt(pos);
      if (ch === 0x22) {
        out += text.slice(chunk, pos);
        pos++;
        return out;
      }
      if (ch < 0x20) fail("Invalid control character");
      if (ch !== 0x5c) {
        pos++;
        continue;
      }
      out += text.slice(chunk, pos);
      const esc = text[pos + 1];
      pos += 2;
      switch (esc) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid \\uXXXX escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          pos += 4;
          break;
        }
        default:
          fail("Invalid \\escape");
      }
      chunk = pos;
    }
  };

  const parseValue = (): unknown => {
    skip();
    const ch = text[pos];
    if (ch === "{") {
      pos++;
      const out: Record<string, unknown> = {};
      skip();
      if (text[pos] === "}") {
        pos++;
        return out;
      }
      for (;;) {
        skip();
        if (text[pos] !== '"') fail("Expecting property name enclosed in double quotes");
        const key = parseString();
        skip();
        if (text[pos] !== ":") fail("Expecting ':' delimiter");
        pos++;
        out[key] = parseValue();
        skip();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "}") {
          pos++;
          return out;
        }
        fail("Expecting ',' delimiter");
      }
    }
    if (ch === "[") {
      pos++;
      const out: unknown[] = [];
      skip();
      if (text[pos] === "]") {
        pos++;
        return out;
      }
      for (;;) {
        out.push(parseValue());
        skip();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "]") {
          pos++;
          return out;
        }
        fail("Expecting ',' delimiter");
      }
    }
    if (ch === '"') return parseString();
    if (ch === "t") return literal("true", true);
    if (ch === "f") return literal("false", false);
    if (ch === "n") return literal("null", null);
    if (ch === "N") return literal("NaN", Number.NaN);
    if (ch === "I") return literal("Infinity", Number.POSITIVE_INFINITY);
    if (ch === "-" && text.startsWith("-Infinity", pos)) {
      return literal("-Infinity", Number.NEGATIVE_INFINITY);
    }
    NUMBER.lastIndex = pos;
    const m = NUMBER.exec(text);
    if (m === null) return fail("Expecting value");
    pos = NUMBER.lastIndex;
    return number(m[0], m[1] === undefined && m[2] === undefined);
  };

  const value = parseValue();
  skip();
  if (pos !== text.length) fail("Extra data");
  return value;
}

/** A plain JSON object (Python `isinstance(x, dict)`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `isinstance(x, int | float) and not isinstance(x, bool)` for a parsed JSON value. */
export function isPyNumber(value: unknown): value is number {
  return typeof value === "number";
}
