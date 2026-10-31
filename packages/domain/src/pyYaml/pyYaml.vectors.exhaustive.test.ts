import { describe, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import { yamlOut } from "./testing/vectorOut.js";

// Every document of parity/python/vectors_yaml.py against yaml.compose(text, Loader=SafeLoader)
// (exhaustive tier, see references/testing.md "Test tiers").
const SLICE = 150;

describe.each(["yaml-cases", "yaml-random", "yaml-mutations", "yaml-soup"])(
  "%s vectors",
  (name) => {
    const rows = loadVectors(name).rows as [string, unknown][];
    const slices = Array.from({ length: Math.ceil(rows.length / SLICE) }, (_, i) => i * SLICE);
    it.each(slices)("rows %i.. : node trees and errors equal PyYAML", (start) => {
      const m = new Mismatches();
      for (const [i, [text, want]] of rows.slice(start, start + SLICE).entries()) {
        m.check(`#${start + i} ${JSON.stringify(text.slice(0, 60))}`, yamlOut(text), want);
      }
      expectAll(m);
    });
  },
);
