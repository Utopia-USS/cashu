/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  decodeFirst,
  decodeReplace,
  decodeStrict,
  encodeUtf8,
  LoneSurrogateError,
  translateNewlines,
} from "./codecs.js";

// Polish bank CSV exports come in UTF-8 (with or without BOM), cp1250 or ISO-8859-2.
describe("codecs", () => {
  it("refuses cp1250's five undefined bytes and replaces invalid bytes with U+FFFD", () => {
    for (const b of [0x81, 0x83, 0x88, 0x90, 0x98])
      expect(decodeStrict(Uint8Array.of(0x61, b), "cp1250")).toEqual({ ok: false, start: 1 });
    expect(decodeReplace(Uint8Array.of(0x61, 0xff, 0x62), "utf-8")).toBe("a\ufffdb");
    expect(decodeReplace(Uint8Array.of(0x61, 0x81), "cp1250")).toBe("a\ufffd");
  });

  it("utf-8-sig drops the BOM, utf-8 keeps it", () => {
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0xc5, 0xbc);
    expect(decodeStrict(bytes, "utf-8-sig")).toEqual({ ok: true, text: "ż" });
    expect(decodeStrict(bytes, "utf-8")).toEqual({ ok: true, text: "\ufeffż" });
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
