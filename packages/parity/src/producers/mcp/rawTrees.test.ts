// The raw-tree adapter of the MCP privacy parity producer, on synthetic canonical trees.
import { Labelled, pyDumps, Redactor } from "@cashu/mcp";
import { describe, expect, it } from "vitest";
import { parseCanonical } from "../../json.ts";
import { dumps } from "../output.ts";
import { AdapterError, SyntheticIds, toCanonical, toLabelledTree } from "./rawTrees.ts";

const tree = (json: string, ids = new SyntheticIds()) => toLabelledTree(parseCanonical(json), ids);

describe("toLabelledTree", () => {
  it("restores labels, ints, floats and strings", () => {
    const t = tree(
      '{"a":{"$label":"count","value":3},"b":{"$label":"percent","value":0.5},"c":{"$label":"text","value":"x"}}',
    ) as Record<string, Labelled>;
    expect(t.a).toEqual(new Labelled(3n, "count"));
    expect(t.b).toEqual(new Labelled(0.5, "percent"));
    expect(t.c).toEqual(new Labelled("x", "text"));
  });

  it("maps natural keys under id fields to small synthetic refs and back", () => {
    const ids = new SyntheticIds();
    const raw =
      '{"items":[{"alert_id":{"$label":"ref","value":"alert:0123456789abcdef"}}],"run_ids":[{"$label":"ref","value":"research-run:00000000000000aa~2"}]}';
    const t = tree(raw, ids);
    const out = new Redactor({ privacy: "strict" }).apply(t);
    expect(pyDumps(out)).toBe('{"items": [{"alert_id": 1}], "run_ids": [2]}');
    expect(dumps(toCanonical(out, ids))).toBe(
      '{"items":[{"alert_id":"alert:0123456789abcdef"}],"run_ids":["research-run:00000000000000aa~2"]}\n',
    );
  });

  it("keeps natural-key-like strings outside id fields as strings", () => {
    const t = tree('{"note":{"$label":"ref","value":"alert:0123456789abcdef"}}') as Record<
      string,
      Labelled
    >;
    expect(t.note?.value).toBe("alert:0123456789abcdef");
  });

  it("restores NaN / Infinity and Decimals under numeric labels only", () => {
    const t = tree(
      '{"a":{"$label":"percent","value":"NaN"},"b":{"$label":"amount","value":"1.50"},"c":{"$label":"text","value":"NaN"}}',
    ) as Record<string, Labelled>;
    expect(Number.isNaN(t.a?.value)).toBe(true);
    expect(String(t.b?.value)).toBe("1.50");
    expect(t.c?.value).toBe("NaN");
  });

  it("refuses what canon.py made undecidable", () => {
    expect(() => tree('{"at":{"$label":"date","value":"2026-10-01T12:00:00"}}')).toThrow(
      AdapterError,
    );
    expect(() => tree('{"at":{"$label":"date","value":"2026-10-01T12:00:00+02:00"}}')).toThrow(
      AdapterError,
    );
    expect(() => tree('{"x_id":{"$label":"text","value":"txn:0123456789abcdef"}}')).toThrow(
      AdapterError,
    );
    expect(() => tree('{"x_id":{"$label":"ref","value":5}}')).toThrow(AdapterError);
    expect(() => tree('{"x":"bare"}')).toThrow(AdapterError);
    expect(tree('{"at":{"$label":"date","value":"2026-10-01T12:00:00+00:00"}}')).toBeTruthy();
  });
});

describe("toCanonical", () => {
  it("writes floats as Python floats and refuses unmapped ids", () => {
    expect(dumps(toCanonical({ w: 2, n: 3n }, new SyntheticIds()))).toBe('{"n":3,"w":2.0}\n');
    expect(() => toCanonical({ account_id: 7n }, new SyntheticIds())).toThrow(AdapterError);
    expect(() => toCanonical({ account_id: "17" }, new SyntheticIds())).toThrow(AdapterError);
  });
});
