// The outcome of `composeYaml` in the shape the retired Python `vectors_yaml.py` writes (test helper).
import type { YamlMark, YamlNode } from "../index.js";
import { composeYaml } from "../index.js";

const marks = (start: YamlMark, end: YamlMark) => [
  start.line,
  start.column,
  start.index,
  end.line,
  end.column,
  end.index,
];

const markOut = (mark: YamlMark | null) =>
  mark === null ? null : [mark.line, mark.column, mark.index];

/** `node_out`: pre-order walk, a node seen before (an alias) as `["r", its pre-order number]`. */
export function treeOut(root: YamlNode): unknown[] {
  const seen = new Map<YamlNode, number>();
  const walk = (node: YamlNode): unknown[] => {
    const known = seen.get(node);
    if (known !== undefined) return ["r", known];
    seen.set(node, seen.size);
    const m = marks(node.startMark, node.endMark);
    switch (node.kind) {
      case "scalar":
        return ["s", node.tag, node.value, node.style, ...m];
      case "sequence":
        return ["q", node.tag, node.flowStyle, ...m, node.value.map(walk)];
      case "mapping":
        return [
          "m",
          node.tag,
          node.flowStyle,
          ...m,
          node.value.map(([k, v]) => [walk(k), walk(v)]),
        ];
    }
  };
  return walk(root);
}

/** `outcome(text)` of the generator. */
export function yamlOut(text: string): unknown {
  const result = composeYaml(text);
  if (result.ok) return { node: result.node === null ? null : treeOut(result.node) };
  const e = result.error;
  if (e.kind === "reader") return { error: { kind: "reader", text: e.text } };
  return {
    error: {
      kind: "marked",
      context: e.context,
      context_mark: markOut(e.contextMark),
      problem: e.problem,
      problem_mark: markOut(e.problemMark),
      note: e.note,
      text: e.text,
    },
  };
}
