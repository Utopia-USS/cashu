/**
 * The Python text codecs cashU's importers use (`bytes.decode` / `Path.read_text`), as pure tables.
 *
 * Pure on purpose: Hermes ships no windows-1250 / iso-8859-2 `TextDecoder`, and the WHATWG decoders
 * differ from Python anyway (cp1250 leaves 0x81 0x83 0x88 0x90 0x98 undefined, WHATWG maps them to C1
 * controls). Error positions are Python's `UnicodeDecodeError.start`. Checked against Python by
 * `codecs.test.ts` (`budget-codecs.jsonl`, written by the retired Python `vectors_budget.py`).
 */

export type PyCodec = "utf-8" | "utf-8-sig" | "cp1250" | "iso-8859-2";

/** `start` = Python's `UnicodeDecodeError.start` (for utf-8-sig counted after a leading BOM). */
export type DecodeResult = { ok: true; text: string } | { ok: false; start: number };

/** Thrown by `encodeUtf8` for a lone surrogate (Python's `str.encode` raises too). */
export class LoneSurrogateError extends Error {
  constructor() {
    super("a lone surrogate cannot be encoded as UTF-8");
    this.name = "LoneSurrogateError";
  }
}

const UNDEFINED = -1;

/** cp1250 bytes 0x80..0xFF -> code point (`UNDEFINED`: Python refuses the byte). */
const CP1250_HIGH: readonly number[] = [
  0x20ac, -1, 0x201a, -1, 0x201e, 0x2026, 0x2020, 0x2021, -1, 0x2030, 0x160, 0x2039, 0x15a, 0x164,
  0x17d, 0x179, -1, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, -1, 0x2122, 0x161,
  0x203a, 0x15b, 0x165, 0x17e, 0x17a, 0xa0, 0x2c7, 0x2d8, 0x141, 0xa4, 0x104, 0xa6, 0xa7, 0xa8,
  0xa9, 0x15e, 0xab, 0xac, 0xad, 0xae, 0x17b, 0xb0, 0xb1, 0x2db, 0x142, 0xb4, 0xb5, 0xb6, 0xb7,
  0xb8, 0x105, 0x15f, 0xbb, 0x13d, 0x2dd, 0x13e, 0x17c, 0x154, 0xc1, 0xc2, 0x102, 0xc4, 0x139,
  0x106, 0xc7, 0x10c, 0xc9, 0x118, 0xcb, 0x11a, 0xcd, 0xce, 0x10e, 0x110, 0x143, 0x147, 0xd3, 0xd4,
  0x150, 0xd6, 0xd7, 0x158, 0x16e, 0xda, 0x170, 0xdc, 0xdd, 0x162, 0xdf, 0x155, 0xe1, 0xe2, 0x103,
  0xe4, 0x13a, 0x107, 0xe7, 0x10d, 0xe9, 0x119, 0xeb, 0x11b, 0xed, 0xee, 0x10f, 0x111, 0x144, 0x148,
  0xf3, 0xf4, 0x151, 0xf6, 0xf7, 0x159, 0x16f, 0xfa, 0x171, 0xfc, 0xfd, 0x163, 0x2d9,
];

/** iso-8859-2 bytes 0xA0..0xFF -> code point (0x80..0x9F are the C1 controls, identity). */
const ISO_8859_2_A0: readonly number[] = [
  0xa0, 0x104, 0x2d8, 0x141, 0xa4, 0x13d, 0x15a, 0xa7, 0xa8, 0x160, 0x15e, 0x164, 0x179, 0xad,
  0x17d, 0x17b, 0xb0, 0x105, 0x2db, 0x142, 0xb4, 0x13e, 0x15b, 0x2c7, 0xb8, 0x161, 0x15f, 0x165,
  0x17a, 0x2dd, 0x17e, 0x17c, 0x154, 0xc1, 0xc2, 0x102, 0xc4, 0x139, 0x106, 0xc7, 0x10c, 0xc9,
  0x118, 0xcb, 0x11a, 0xcd, 0xce, 0x10e, 0x110, 0x143, 0x147, 0xd3, 0xd4, 0x150, 0xd6, 0xd7, 0x158,
  0x16e, 0xda, 0x170, 0xdc, 0xdd, 0x162, 0xdf, 0x155, 0xe1, 0xe2, 0x103, 0xe4, 0x13a, 0x107, 0xe7,
  0x10d, 0xe9, 0x119, 0xeb, 0x11b, 0xed, 0xee, 0x10f, 0x111, 0x144, 0x148, 0xf3, 0xf4, 0x151, 0xf6,
  0xf7, 0x159, 0x16f, 0xfa, 0x171, 0xfc, 0xfd, 0x163, 0x2d9,
];

function singleByte(b: number, codec: "cp1250" | "iso-8859-2"): number {
  if (b < 0x80) return b;
  if (codec === "cp1250") return CP1250_HIGH[b - 0x80] ?? UNDEFINED;
  return b < 0xa0 ? b : (ISO_8859_2_A0[b - 0xa0] ?? UNDEFINED);
}

/** Collects code points into a string without one call per character. */
class TextBuilder {
  private readonly parts: string[] = [];
  private pending: number[] = [];

  push(cp: number): void {
    this.pending.push(cp);
    if (this.pending.length >= 4096) this.flush();
  }

  private flush(): void {
    if (this.pending.length) this.parts.push(String.fromCodePoint(...this.pending));
    this.pending = [];
  }

  build(): string {
    this.flush();
    return this.parts.join("");
  }
}

const REPLACEMENT = 0xfffd;

function decodeSingleByte(
  bytes: Uint8Array,
  codec: "cp1250" | "iso-8859-2",
  replace: boolean,
): DecodeResult {
  const out = new TextBuilder();
  for (let i = 0; i < bytes.length; i++) {
    const cp = singleByte(bytes[i] as number, codec);
    if (cp === UNDEFINED) {
      if (!replace) return { ok: false, start: i };
      out.push(REPLACEMENT);
    } else {
      out.push(cp);
    }
  }
  return { ok: true, text: out.build() };
}

/** What the first byte of a UTF-8 sequence promises: continuation bytes owed and their first range. */
function leadByte(b: number): { need: number; bits: number; lower: number; upper: number } {
  if (b >= 0xc2 && b <= 0xdf) return { need: 1, bits: b & 0x1f, lower: 0x80, upper: 0xbf };
  if (b >= 0xe0 && b <= 0xef) {
    return {
      need: 2,
      bits: b & 0x0f,
      lower: b === 0xe0 ? 0xa0 : 0x80,
      upper: b === 0xed ? 0x9f : 0xbf,
    };
  }
  if (b >= 0xf0 && b <= 0xf4) {
    return {
      need: 3,
      bits: b & 0x07,
      lower: b === 0xf0 ? 0x90 : 0x80,
      upper: b === 0xf4 ? 0x8f : 0xbf,
    };
  }
  return { need: 0, bits: 0, lower: 0x80, upper: 0xbf };
}

/**
 * CPython's `UnicodeDecodeError.reason` for the UTF-8 error at `start` (as reported by
 * `decodeStrict`; `bytes` is the decoded body, after a BOM).
 */
export type Utf8ErrorReason =
  | "invalid start byte"
  | "invalid continuation byte"
  | "unexpected end of data";

/** The reason `bytes.decode("utf-8")` gives for the invalid sequence starting at `start`. */
export function utf8ErrorReason(bytes: Uint8Array, start: number): Utf8ErrorReason {
  const lead = leadByte(bytes[start] as number);
  if (lead.need === 0) return "invalid start byte";
  let { lower, upper } = lead;
  for (let k = 1; k <= lead.need; k++) {
    const c = bytes[start + k];
    if (c === undefined) return "unexpected end of data";
    if (c < lower || c > upper) return "invalid continuation byte";
    lower = 0x80;
    upper = 0xbf;
  }
  throw new RangeError(`no UTF-8 error at byte ${start}`);
}

/**
 * CPython's UTF-8 decoder: an invalid sequence is its maximal valid prefix (at least one byte),
 * replaced by one U+FFFD (`errors="replace"`) or reported at its first byte (strict). Overlong forms,
 * surrogates and code points above U+10FFFF are invalid.
 */
function decodeUtf8(bytes: Uint8Array, from: number, replace: boolean): DecodeResult {
  const out = new TextBuilder();
  const n = bytes.length;
  let i = from;
  while (i < n) {
    const b = bytes[i] as number;
    if (b < 0x80) {
      out.push(b);
      i++;
      continue;
    }
    const lead = leadByte(b);
    const need = lead.need;
    let cp = lead.bits;
    let lower = lead.lower;
    let upper = lead.upper;
    let j = i + 1;
    let valid = need > 0;
    for (let k = 0; valid && k < need; k++) {
      const c = bytes[j];
      if (c === undefined || c < lower || c > upper) {
        valid = false;
        break;
      }
      cp = (cp << 6) | (c & 0x3f);
      lower = 0x80;
      upper = 0xbf;
      j++;
    }
    if (valid) {
      out.push(cp);
      i = j;
      continue;
    }
    if (!replace) return { ok: false, start: i - from };
    out.push(REPLACEMENT);
    i = Math.max(j, i + 1);
  }
  return { ok: true, text: out.build() };
}

function hasBom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function decodeWith(bytes: Uint8Array, codec: PyCodec, replace: boolean): DecodeResult {
  switch (codec) {
    case "utf-8":
      return decodeUtf8(bytes, 0, replace);
    case "utf-8-sig":
      // encodings/utf_8_sig.py: one leading BOM dropped, the rest decoded (positions after it).
      return decodeUtf8(bytes, hasBom(bytes) ? 3 : 0, replace);
    case "cp1250":
    case "iso-8859-2":
      return decodeSingleByte(bytes, codec, replace);
  }
}

/** `bytes.decode(codec)` (strict). */
export function decodeStrict(bytes: Uint8Array, codec: PyCodec): DecodeResult {
  return decodeWith(bytes, codec, false);
}

/** `bytes.decode(codec, errors="replace")`. */
export function decodeReplace(bytes: Uint8Array, codec: PyCodec): string {
  const result = decodeWith(bytes, codec, true);
  return result.ok ? result.text : "";
}

/**
 * The importers' `_read_text` loop over `Path.read_text(encoding=...)`: the first codec that decodes
 * the whole file wins; when none does, the last codec's error. Newlines are NOT translated here
 * (`translateNewlines`).
 */
export function decodeFirst(bytes: Uint8Array, codecs: readonly PyCodec[]): DecodeResult {
  let last: DecodeResult = { ok: false, start: 0 };
  for (const codec of codecs) {
    last = decodeStrict(bytes, codec);
    if (last.ok) return last;
  }
  return last;
}

/** Text-mode universal newlines (`read_text`): `\r\n` and a lone `\r` become `\n`. */
export function translateNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** `str.encode("utf-8")`; throws `LoneSurrogateError` where Python would raise. */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      const next = text.charCodeAt(i + 1);
      if (cp > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) throw new LoneSurrogateError();
      cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
      i++;
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return Uint8Array.from(out);
}
