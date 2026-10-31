/** Text decoding of broker exports: UTF-8 (optional BOM), Windows-1250, or auto-detection. */

import {
  decodeReplace,
  decodeStrict,
  type Utf8ErrorReason,
  utf8ErrorReason,
} from "../../codecs.js";
import { pyLower, pyStrip } from "../../text.js";

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

/** Text encodings broker exports come in (the values are the mapping wire names). */
export const ImportTextEncoding = Object.freeze({
  /** UTF-8, with or without a leading byte order mark. Malformed input is an error. */
  UTF8: "utf-8",
  /** Windows-1250 (Central European code page), common in Polish broker exports. */
  WINDOWS_1250: "windows-1250",
  /** UTF-8 when the bytes are valid UTF-8 (or start with a UTF-8 BOM), otherwise Windows-1250. */
  AUTO: "auto",
} as const);
export type ImportTextEncoding = (typeof ImportTextEncoding)[keyof typeof ImportTextEncoding];

const ENCODING_BY_NAME: ReadonlyMap<string, ImportTextEncoding> = new Map([
  ["utf-8", ImportTextEncoding.UTF8],
  ["utf8", ImportTextEncoding.UTF8],
  ["utf-8-sig", ImportTextEncoding.UTF8],
  ["windows-1250", ImportTextEncoding.WINDOWS_1250],
  ["windows1250", ImportTextEncoding.WINDOWS_1250],
  ["cp1250", ImportTextEncoding.WINDOWS_1250],
  ["cp-1250", ImportTextEncoding.WINDOWS_1250],
  ["auto", ImportTextEncoding.AUTO],
]);

/** Every spelling `parseEncoding` accepts. */
export const ENCODING_NAMES: readonly string[] = Object.freeze([...ENCODING_BY_NAME.keys()]);

/**
 * A mapping value (`utf-8` / `utf8`, `windows-1250` / `cp1250`, `auto`; case-insensitive), or null for
 * anything else.
 */
export function parseEncoding(value: string): ImportTextEncoding | null {
  return ENCODING_BY_NAME.get(pyLower(pyStrip(value))) ?? null;
}

/** Whether `data` starts with the UTF-8 byte order mark (EF BB BF). */
export function hasUtf8Bom(data: Uint8Array): boolean {
  return UTF8_BOM.every((byte, index) => data[index] === byte);
}

/** `UnicodeDecodeError`: where (`start`, a byte index after a BOM) and why. */
export interface TextDecodeFailure {
  readonly ok: false;
  readonly reason: Utf8ErrorReason;
  readonly start: number;
}

export type TextDecodeResult = { readonly ok: true; readonly text: string } | TextDecodeFailure;

export interface DecodeOptions {
  /**
   * Malformed UTF-8 becomes U+FFFD instead of failing (cheap header sniffing on a truncated prefix).
   */
  readonly lenient?: boolean;
}

/**
 * `decode_import_text`: decode `data` as `encoding`; a leading UTF-8 BOM is removed.
 *
 * Fails for malformed UTF-8 unless `lenient`. Windows-1250 never fails: its five undefined bytes (0x81,
 * 0x83, 0x88, 0x90, 0x98) become U+FFFD.
 */
export function decodeImportText(
  data: Uint8Array,
  encoding: ImportTextEncoding,
  options: DecodeOptions = {},
): TextDecodeResult {
  if (encoding === ImportTextEncoding.WINDOWS_1250) return decodeCp1250(data);
  if (encoding === ImportTextEncoding.UTF8 || hasUtf8Bom(data)) {
    return decodeUtf8(data, options.lenient ?? false);
  }
  const utf8 = decodeUtf8(data, false);
  return utf8.ok ? utf8 : decodeCp1250(data);
}

function decodeUtf8(data: Uint8Array, lenient: boolean): TextDecodeResult {
  if (lenient) return { ok: true, text: dropBom(decodeReplace(data, "utf-8-sig")) };
  const decoded = decodeStrict(data, "utf-8-sig");
  if (decoded.ok) return { ok: true, text: dropBom(decoded.text) };
  const body = hasUtf8Bom(data) ? data.subarray(UTF8_BOM.length) : data;
  return { ok: false, start: decoded.start, reason: utf8ErrorReason(body, decoded.start) };
}

/** A BOM-less file can still carry U+FEFF as its first character when it was re-encoded. */
function dropBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

function decodeCp1250(data: Uint8Array): TextDecodeResult {
  return { ok: true, text: decodeReplace(data, "cp1250") };
}
