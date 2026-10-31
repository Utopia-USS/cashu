/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  decodeFirst,
  decodeReplace,
  decodeStrict,
  encodeUtf8,
  LoneSurrogateError,
  type PyCodec,
  translateNewlines,
} from "./codecs.js";
import { loadVectors, Mismatches } from "./testing/vectors.js";

const vectors = loadVectors("budget-codecs");
const CODECS: readonly PyCodec[] = ["utf-8", "utf-8-sig", "cp1250", "iso-8859-2"];
const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

describe("codecs vectors (parity/python/vectors_budget.py)", () => {
  it("single-byte tables equal Python's for all 256 bytes", () => {
    for (const row of vectors.rows.filter((r) => r[0] === "table")) {
      const codec = row[1] as PyCodec;
      const table = row[2] as (number | null)[];
      const got = table.map((_, b) => {
        const r = decodeStrict(Uint8Array.of(b), codec);
        return r.ok ? (r.text.codePointAt(0) as number) : null;
      });
      expect(got).toEqual(table);
    }
  });

  it("strict and replace decoding equal Python on random and malformed bytes", () => {
    const m = new Mismatches();
    for (const row of vectors.rows.filter((r) => r[0] === "bytes")) {
      const bytes = bytesOf(row[1] as string);
      const strict = row[2] as Record<string, ["ok", string] | ["err", number]>;
      const replace = row[3] as Record<string, string>;
      for (const codec of CODECS) {
        const r = decodeStrict(bytes, codec);
        m.check(
          `${row[1]} ${codec} strict`,
          r.ok ? ["ok", r.text] : ["err", r.start],
          strict[codec],
        );
        m.check(`${row[1]} ${codec} replace`, decodeReplace(bytes, codec), replace[codec]);
      }
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBeGreaterThan(15000);
  });

  it("the tables agree with the WHATWG decoders except cp1250's five undefined bytes", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const iso = decodeStrict(all, "iso-8859-2");
    expect(iso.ok && iso.text).toBe(new TextDecoder("iso-8859-2").decode(all));
    const defined = all.filter((b) => ![0x81, 0x83, 0x88, 0x90, 0x98].includes(b));
    const cp = decodeStrict(defined, "cp1250");
    expect(cp.ok && cp.text).toBe(new TextDecoder("windows-1250").decode(defined));
  });
});

describe("decodeFirst / translateNewlines / encodeUtf8", () => {
  it("takes the first codec that decodes, else the last error", () => {
    const cp1250Only = Uint8Array.of(0x61, 0xb9); // "aą" in cp1250, invalid UTF-8
    expect(decodeFirst(cp1250Only, ["utf-8-sig", "cp1250"])).toEqual({ ok: true, text: "aą" });
    expect(decodeFirst(Uint8Array.of(0x81), ["utf-8", "cp1250"])).toEqual({ ok: false, start: 0 });
  });

  it("translates \\r\\n and a lone \\r like read_text", () => {
    expect(translateNewlines("a\r\nb\rc\n\r\n")).toBe("a\nb\nc\n\n");
  });

  it("encodes UTF-8 like Python and refuses lone surrogates", () => {
    const text = "aż€😀\u0000";
    expect(Buffer.from(encodeUtf8(text)).equals(Buffer.from(text, "utf8"))).toBe(true);
    expect(() => encodeUtf8("\ud800")).toThrow(LoneSurrogateError);
    expect(() => encodeUtf8("a\udc00")).toThrow(LoneSurrogateError);
  });
});
