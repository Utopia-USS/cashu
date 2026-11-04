/// <reference types="node" />
// The code point sweeps against Python (exhaustive tier, see references/testing.md): `\w`, `\d`, `\s`,
// `.`, casefold, NFKD and NFKC over every code point, one test per Unicode plane, and the IGNORECASE
// units over the BMP. Vectors: parity/python/generators/domain/research_vectors.py.
import { describe, expect, it } from "vitest";
import { pyCasefold } from "../../casefold.js";
import { PY_D, PY_W, translatePyPattern } from "../../pyRegex.js";
import {
  BLOCK_SIZE,
  BLOCKS_PER_PLANE,
  blockHash,
  expectAll,
  loadVectors,
  Mismatches,
  PLANES,
} from "../../testing/vectors.js";
import { PY_WS } from "../../text.js";

type Row = readonly unknown[];

describe("Python regex classes, casefold and normalization over every code point", () => {
  const { rows } = loadVectors("research-classes");
  const fullmatch = (body: string) => new RegExp(`^${body}$`, "u");
  const word = fullmatch(`[${PY_W}]`);
  const digit = fullmatch(PY_D);
  const space = fullmatch(`[${PY_WS}]`);
  const dot = new RegExp(`^${translatePyPattern(".").source}$`, "u");
  const fns: Record<string, (c: string) => string> = {
    w: (c) => (word.test(c) ? "1" : "0"),
    d: (c) => (digit.test(c) ? "1" : "0"),
    s: (c) => (space.test(c) ? "1" : "0"),
    dot: (c) => (dot.test(c) ? "1" : "0"),
    casefold: pyCasefold,
    nfkd: (c) => c.normalize("NFKD"),
    nfkc: (c) => c.normalize("NFKC"),
  };

  const hexPoint = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

  // One test per plane (16 blocks, 65,536 code points) so no single test holds the whole sweep.
  it.each(PLANES)(
    "\\w, \\d, \\s, ., casefold, NFKD and NFKC agree block by block in plane %i",
    (plane) => {
      const m = new Mismatches();
      const tables = (rows as readonly Row[]).filter(
        (row) => typeof row[0] === "string" && row[0] in fns,
      );
      expect(tables.map((row) => row[0]).sort()).toEqual(Object.keys(fns).sort());
      for (const row of tables) {
        const fn = fns[row[0] as string] as (c: string) => string;
        for (
          let block = plane * BLOCKS_PER_PLANE;
          block < (plane + 1) * BLOCKS_PER_PLANE;
          block++
        ) {
          m.check(
            `${String(row[0])} block ${block} (${hexPoint(block * BLOCK_SIZE)})`,
            blockHash(fn, block),
            (row[1] as string[])[block],
          );
        }
      }
      expectAll(m);
    },
  );

  it("IGNORECASE units match the same code points (BMP)", () => {
    const m = new Mismatches();
    for (const row of rows as readonly Row[]) {
      if (row[0] !== "ignorecase") continue;
      const { source } = translatePyPattern(`(?i)${row[1] as string}`);
      const re = new RegExp(`^(?:${source})$`, "iu");
      const ours: number[] = [];
      for (let c = 0; c < 0x10000; c++) {
        if (c >= 0xd800 && c <= 0xdfff) continue;
        if (re.test(String.fromCodePoint(c))) ours.push(c);
      }
      m.check(`(?i)${row[1] as string}`, ours, row[2]);
    }
    expectAll(m);
  });
});
