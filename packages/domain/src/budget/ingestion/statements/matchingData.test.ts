/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadVectors } from "../../../testing/vectors.js";
import { DEFAULT_DELIMITERS, DEFAULT_ENCODINGS } from "./delimited.js";
import { ERSTE_ENCODINGS, ERSTE_SIGNATURE } from "./erste.js";
import {
  MBANK_COLMAP,
  MBANK_DELIMITERS,
  MBANK_ENCODINGS,
  MBANK_META_MARKERS,
  MBANK_SIGNATURE,
} from "./mbank.js";
import { PEKAO_COLS, PEKAO_DELIMITERS, PEKAO_ENCODINGS, PEKAO_SIGNATURE } from "./pekao.js";

/** `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
  return [];
}

const [, python, sha] = loadVectors("budget-matching-data").rows[0] as [
  string,
  Record<string, Record<string, unknown>>,
  string,
];

describe("Polish matching data: byte-identical to the live Python objects", () => {
  it("the bank parsers' encodings, delimiters, signatures, column names and markers", () => {
    const colmapOrder = python.mbank?.colmap_order as string[];
    const ts = {
      base: { ...python.base, DEFAULT_ENCODINGS, DEFAULT_DELIMITERS },
      mbank: {
        encodings: MBANK_ENCODINGS,
        delimiters: MBANK_DELIMITERS,
        signature: MBANK_SIGNATURE,
        colmap: MBANK_COLMAP,
        colmap_order: colmapOrder,
        meta_markers: [MBANK_META_MARKERS.account, MBANK_META_MARKERS.currency],
      },
      erste: { encodings: ERSTE_ENCODINGS, signature: ERSTE_SIGNATURE },
      pekao: {
        encodings: PEKAO_ENCODINGS,
        delimiters: PEKAO_DELIMITERS,
        signature: PEKAO_SIGNATURE,
        cols: PEKAO_COLS,
        cols_order: Object.keys(PEKAO_COLS),
      },
      normalize: python.normalize,
    };
    expect(JSON.parse(stableStringify(ts))).toEqual(python);
    const text = stableStringify(ts);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(sha);
    for (const s of strings(ts)) expect(s.normalize("NFC")).toBe(s);
  });
});
