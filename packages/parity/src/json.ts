/// <reference types="node" />
import { createHash } from "node:crypto";

/**
 * Reader for the canonical JSON the Python goldens are written in (`parity/python/canon.py`).
 *
 * `JSON.parse` is not enough: it merges `1` and `1.0`, loses integers above 2^53 and silently keeps
 * the last of two equal keys. This parser keeps integer tokens as `bigint` and float tokens as
 * `number`, and rejects duplicate keys, `NaN` / `Infinity` literals (the canonical form writes them as
 * strings), comments and trailing garbage. Errors carry an offset, never any of the input text.
 */
export type CanonValue = null | boolean | string | bigint | number | CanonValue[] | CanonObject;

/** An object keeps its keys in a `Map`, so `__proto__` and friends are ordinary keys. */
export type CanonObject = Map<string, CanonValue>;

export class CanonParseError extends Error {
  readonly offset: number;

  constructor(reason: string, offset: number) {
    super(`${reason} at offset ${offset}`);
    this.name = "CanonParseError";
    this.offset = offset;
  }
}

const MAX_DEPTH = 512;
const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

class Reader {
  private i = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): CanonValue {
    this.skipSpace();
    const value = this.value(0);
    this.skipSpace();
    if (this.i !== this.text.length) this.fail("trailing characters");
    return value;
  }

  private fail(reason: string): never {
    throw new CanonParseError(reason, this.i);
  }

  private skipSpace(): void {
    const t = this.text;
    while (this.i < t.length) {
      const c = t.charCodeAt(this.i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) this.i++;
      else break;
    }
  }

  private value(depth: number): CanonValue {
    if (depth > MAX_DEPTH) this.fail("nesting too deep");
    const c = this.text[this.i];
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"') return this.string();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.number();
    if (this.text.startsWith("true", this.i)) return this.literal("true", true);
    if (this.text.startsWith("false", this.i)) return this.literal("false", false);
    if (this.text.startsWith("null", this.i)) return this.literal("null", null);
    return this.fail("unexpected token");
  }

  private literal<T extends boolean | null>(word: string, value: T): T {
    this.i += word.length;
    return value;
  }

  private number(): bigint | number {
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.text);
    if (m === null) return this.fail("invalid number");
    this.i += m[0].length;
    if (m[1] === undefined && m[2] === undefined) return BigInt(m[0]);
    const n = Number(m[0]);
    if (!Number.isFinite(n)) return this.fail("number out of range");
    return n;
  }

  private string(): string {
    const t = this.text;
    const start = this.i;
    let j = start + 1;
    for (;;) {
      if (j >= t.length) {
        this.i = start;
        return this.fail("unterminated string");
      }
      const c = t.charCodeAt(j);
      if (c === 0x22) break;
      if (c < 0x20) {
        this.i = j;
        return this.fail("control character in string");
      }
      j += c === 0x5c ? 2 : 1;
    }
    this.i = j + 1;
    try {
      return JSON.parse(t.slice(start, j + 1)) as string;
    } catch {
      this.i = start;
      return this.fail("invalid string escape");
    }
  }

  private array(depth: number): CanonValue[] {
    const out: CanonValue[] = [];
    this.i++;
    this.skipSpace();
    if (this.text[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      this.skipSpace();
      out.push(this.value(depth + 1));
      this.skipSpace();
      const c = this.text[this.i];
      this.i++;
      if (c === "]") return out;
      if (c !== ",") {
        this.i--;
        return this.fail("expected , or ]");
      }
    }
  }

  private object(depth: number): CanonObject {
    const out: CanonObject = new Map();
    this.i++;
    this.skipSpace();
    if (this.text[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      this.skipSpace();
      if (this.text[this.i] !== '"') this.fail("expected object key");
      const keyAt = this.i;
      const key = this.string();
      if (out.has(key)) {
        this.i = keyAt;
        this.fail("duplicate object key");
      }
      this.skipSpace();
      if (this.text[this.i] !== ":") this.fail("expected :");
      this.i++;
      this.skipSpace();
      out.set(key, this.value(depth + 1));
      this.skipSpace();
      const c = this.text[this.i];
      this.i++;
      if (c === "}") return out;
      if (c !== ",") {
        this.i--;
        return this.fail("expected , or }");
      }
    }
  }
}

/** Parse canonical JSON text. Throws {@link CanonParseError} (offset only, no input text). */
export function parseCanonical(text: string): CanonValue {
  return new Reader(text).parseDocument();
}

/** Lower-case hex sha256 of bytes or text (the `sha256` of `index.json` is over the file bytes). */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export type CanonType = "null" | "boolean" | "string" | "int" | "float" | "array" | "object";

export function canonType(v: CanonValue): CanonType {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  if (typeof v === "bigint") return "int";
  if (typeof v === "number") return "float";
  if (Array.isArray(v)) return "array";
  return "object";
}
