import { describe, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import { yamlOut } from "./testing/vectorOut.js";

// The random, mutated and soup documents recorded from yaml.compose(text, Loader=SafeLoader) by the
// retired Python app (exhaustive tier, see references/testing.md "Test tiers"; yaml-cases replays in
// pyYaml.test.ts).
const SLICE = 150;

describe.each(["yaml-random", "yaml-mutations", "yaml-soup"])("%s vectors", (name) => {
  const rows = loadVectors(name).rows as [string, unknown][];
  const slices = Array.from({ length: Math.ceil(rows.length / SLICE) }, (_, i) => i * SLICE);
  it.each(slices)("rows %i.. : node trees and errors equal PyYAML", (start) => {
    const m = new Mismatches();
    for (const [i, [text, want]] of rows.slice(start, start + SLICE).entries()) {
      m.check(`#${start + i} ${JSON.stringify(text.slice(0, 60))}`, yamlOut(text), want);
    }
    expectAll(m);
  });
});
