import { describe, expect, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import { composeYaml, type YamlNode } from "./index.js";
import { treeOut, yamlOut } from "./testing/vectorOut.js";

const ok = (text: string): YamlNode | null => {
  const result = composeYaml(text);
  if (!result.ok) throw new Error(result.error.text);
  return result.node;
};

const fail = (text: string) => {
  const result = composeYaml(text);
  if (result.ok) throw new Error(`composed: ${text}`);
  return result.error;
};

describe("composeYaml (yaml.compose with SafeLoader)", () => {
  it("composes a block mapping with resolved tags, styles and marks", () => {
    const node = ok("version: 1\nname: 'x'\n");
    expect(node?.kind).toBe("mapping");
    if (node?.kind !== "mapping") return;
    expect(node.tag).toBe("tag:yaml.org,2002:map");
    expect(node.flowStyle).toBe(false);
    const [[k1, v1], [, v2]] = node.value as [[YamlNode, YamlNode], [YamlNode, YamlNode]];
    expect(k1).toMatchObject({ kind: "scalar", value: "version", style: null });
    expect(v1).toMatchObject({ tag: "tag:yaml.org,2002:int", value: "1" });
    expect(v1.startMark).toEqual({ line: 0, column: 9, index: 9 });
    expect(v2).toMatchObject({ tag: "tag:yaml.org,2002:str", style: "'" });
    expect(node.endMark).toEqual({ line: 2, column: 0, index: 21 });
  });

  it("returns null for an empty stream and a comment-only document", () => {
    expect(ok("")).toBeNull();
    expect(ok("# nothing\n")).toBeNull();
  });

  it("counts marks in code points (an astral character is one column)", () => {
    const error = fail("\u{1F600}: [x");
    expect(error.kind).toBe("marked");
    if (error.kind !== "marked") return;
    expect(error.contextMark).toEqual({ line: 0, column: 3, index: 3 });
    expect(error.problemMark).toEqual({ line: 0, column: 5, index: 5 });
    expect(error.text).toContain("line 1, column 6:\n    \u{1F600}: [x\n         ^");
  });

  it("returns the anchored node itself for an alias, also inside itself", () => {
    const node = ok("a: &x [1]\nb: *x\n");
    if (node?.kind !== "mapping") throw new Error("mapping expected");
    expect(node.value[0]?.[1]).toBe(node.value[1]?.[1]);
    const loop = ok("&a [*a]");
    if (loop?.kind !== "sequence") throw new Error("sequence expected");
    expect(loop.value[0]).toBe(loop);
    expect(treeOut(loop)).toEqual([
      "q",
      "tag:yaml.org,2002:seq",
      true,
      0,
      0,
      0,
      0,
      7,
      7,
      [["r", 0]],
    ]);
  });

  it("reports scanner, parser and composer errors like PyYAML", () => {
    expect(fail("a: b: c").text).toBe(
      'mapping values are not allowed here\n  in "<unicode string>", line 1, column 5:\n    a: b: c\n        ^',
    );
    expect(fail("a: 1\n--- b\n")).toMatchObject({
      context: "expected a single document in the stream",
      problem: "but found another document",
    });
    expect(fail("*nope")).toMatchObject({ problem: "found undefined alias 'nope'" });
  });

  it("reports a non-printable character as a ReaderError with its code point position", () => {
    expect(fail("ab\u{1F600}\x07")).toEqual({
      kind: "reader",
      text: 'unacceptable character #x0007: special characters are not allowed\n  in "<unicode string>", position 3',
    });
  });

  it("applies the implicit resolvers to plain scalars only, Python `$` before a final newline", () => {
    const tags = (text: string) => {
      const node = ok(text);
      return node?.kind === "sequence" ? node.value.map((n) => n.tag.slice(18)) : [];
    };
    expect(tags("[yes, 'yes', ! 'yes', 0x1F, 1:20, .5, .inf, 2026-01-05, ~, '', <<, =]")).toEqual([
      "bool",
      "str",
      "bool",
      "int",
      "int",
      "float",
      "float",
      "timestamp",
      "null",
      "str",
      "merge",
      "value",
    ]);
    expect(tags('[! "yes\\n", ! "yes\\n\\n", ! "*"]')).toEqual(["bool", "str", "yaml"]);
  });

  // Deliberate divergences (Python raises a non-YAML exception there; see index.ts).
  it("reports a \\U escape above U+10FFFF as a scanner error (Python: ValueError from chr())", () => {
    expect(fail('"\\U00110000"')).toMatchObject({
      context: "while scanning a double-quoted scalar",
      problem: "chr() arg not in range(0x110000)",
      problemMark: { line: 0, column: 3, index: 3 },
    });
  });

  it("reads a %YAML version over 4300 digits as a number (Python: ValueError from int())", () => {
    const digits = "1".repeat(5000);
    expect(fail(`%YAML ${digits}.1\n--- x`)).toMatchObject({
      problem: "found incompatible YAML document (version 1.* is required)",
    });
    expect(ok(`%YAML 1.${digits}\n--- x`)).toMatchObject({ value: "x" });
  });

  // PyYAML raises RecursionError from about 500 levels.
  it.each([
    ["flow", 600, (d: number) => `${"[".repeat(d)}x${"]".repeat(d)}`],
    ["block", 20000, (d: number) => `${"- ".repeat(d)}x`],
  ])("composes %s nesting of %i levels without using the call stack", (_style, depth, text) => {
    let node = ok(text(depth));
    let levels = 0;
    while (node?.kind === "sequence") {
      node = node.value[0] ?? null;
      levels++;
    }
    expect(levels).toBe(depth);
  });

  it("handles large flat documents and long runs of blank lines", () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `k${i}: v${i}\n`).join("");
    const node = ok(keys);
    expect(node?.kind === "mapping" && node.value.length).toBe(5000);
    const block = ok(`a: |+\n  x\n${"\n".repeat(200000)}`);
    expect(block?.kind === "mapping" && block.value[0]?.[1].value).toHaveLength(200002);
  });

  it("never throws on arbitrary text", () => {
    const alphabet = [
      ..."ab:-?,[]{}#&*!|>'\"%@` \t\n\r\\0.~<=",
      "\x85",
      "\u2028",
      "\uFEFF",
      "\u{1F600}",
      "\x00",
    ];
    let seed = 20261031;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 300; n++) {
      let text = "";
      for (let i = next() % 40; i > 0; i--) text += alphabet[next() % alphabet.length];
      expect(typeof composeYaml(text).ok).toBe("boolean");
    }
  });
});

describe("yaml-cases vectors, every third row (full replay in pyYaml.vectors.exhaustive.test.ts)", () => {
  it("node trees and errors equal PyYAML", () => {
    const rows = loadVectors("yaml-cases").rows as [string, unknown][];
    const m = new Mismatches();
    for (let i = 0; i < rows.length; i += 3) {
      const [text, want] = rows[i] as [string, unknown];
      m.check(`#${i} ${JSON.stringify(text.slice(0, 60))}`, yamlOut(text), want);
    }
    expectAll(m);
  });
});
