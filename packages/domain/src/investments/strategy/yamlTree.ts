/**
 * strategy.yaml as a located node tree (`strategy/yaml_tree.py`): PyYAML's compose step (the port in
 * `pyYaml/`) plus the safety checks plain loading lacks. Duplicate keys, anchors / aliases, merge keys,
 * custom tags, deep nesting and oversized input are rejected with a location.
 */

import { composeYaml, walkYamlEvents, type YamlError, type YamlNode } from "../../pyYaml/index.js";
import { pyIsDigit, pyLen, pySplitlines, pyStrip, unicodeDecimal } from "../../text.js";

/** Largest strategy.yaml accepted (a real one is a few kB). */
export const MAX_STRATEGY_CHARS = 512_000;

/** Deepest mapping / list nesting accepted (the schema needs 5). */
export const MAX_YAML_DEPTH = 32;

const SCALAR_TAGS: ReadonlySet<string> = new Set([
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:timestamp",
]);
const MAP_TAG = "tag:yaml.org,2002:map";
const SEQ_TAG = "tag:yaml.org,2002:seq";
const MERGE_TAG = "tag:yaml.org,2002:merge";
const NULL_TAG = "tag:yaml.org,2002:null";

export type MappingNode = Extract<YamlNode, { kind: "mapping" }>;

export type { YamlNode };

/** `YamlTreeError`: the document cannot be used at all; line / column 1-based, null when unknown. */
interface YamlTreeError {
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
}

export type ComposeResult =
  | { readonly ok: true; readonly root: YamlNode | null }
  | { readonly ok: false; readonly error: YamlTreeError };

/** One mapping entry with its located key and value nodes. */
export interface Entry {
  readonly key: string;
  readonly keyNode: YamlNode;
  readonly value: YamlNode;
}

/** `compose(text)`: the single document of `text` as a node tree (null for an empty document). */
export function compose(text: string): ComposeResult {
  const length = pyLen(text);
  if (length > MAX_STRATEGY_CHARS) {
    return fail(
      `strategy.yaml is too large (${length} characters, max ${MAX_STRATEGY_CHARS})`,
      null,
      null,
    );
  }
  const scanned = prescan(text);
  if (scanned !== null) return { ok: false, error: scanned };
  const composed = composeYaml(text);
  if (!composed.ok) return { ok: false, error: yamlError(composed.error, text) };
  if (composed.node !== null) {
    const problem = check(composed.node);
    if (problem !== null) return { ok: false, error: problem };
  }
  return { ok: true, root: composed.node };
}

function fail(message: string, line: number | null, column: number | null): ComposeResult {
  return { ok: false, error: { message, line, column } };
}

/** The `except yaml.MarkedYAMLError` / `except yaml.reader.ReaderError` branches of `compose`. */
function yamlError(error: YamlError, text: string): YamlTreeError {
  if (error.kind === "reader") {
    // `_first_line(error)`; the position is a code point index into the text
    const chars = Array.from(text).slice(0, error.position);
    const lastBreak = chars.lastIndexOf("\n");
    const line = chars.filter((ch) => ch === "\n").length + 1;
    const column = error.position - (lastBreak + 1) + 1;
    return { message: `Invalid YAML: ${firstLine(error.text)}`, line, column };
  }
  const mark = error.problemMark ?? error.contextMark;
  const problem = error.problem || error.context || "syntax error";
  const context = error.context && error.problem ? ` (${error.context})` : "";
  return {
    message: `Invalid YAML: ${problem}${context}`,
    line: mark === null ? null : mark.line + 1,
    column: mark === null ? null : mark.column + 1,
  };
}

function firstLine(text: string): string {
  const trimmed = pyStrip(text);
  return trimmed === "" ? "syntax error" : (pySplitlines(trimmed)[0] ?? "");
}

/** `_prescan`: rejects aliases and deep nesting on the event stream, before any tree is built. */
function prescan(text: string): YamlTreeError | null {
  let depth = 0;
  let found: YamlTreeError | null = null;
  const walked = walkYamlEvents(text, (event) => {
    if (event.kind === "Alias") {
      found = {
        message: "YAML anchors and aliases (& and *) are not supported",
        line: event.startMark.line + 1,
        column: event.startMark.column + 1,
      };
      return false;
    }
    if (event.kind === "MappingStart" || event.kind === "SequenceStart") {
      depth += 1;
      if (depth > MAX_YAML_DEPTH) {
        found = {
          message: `strategy.yaml is nested too deeply (max ${MAX_YAML_DEPTH} levels)`,
          line: event.startMark.line + 1,
          column: event.startMark.column + 1,
        };
        return false;
      }
    } else if (event.kind === "MappingEnd" || event.kind === "SequenceEnd") {
      depth -= 1;
    }
    return true;
  });
  if (!walked.ok) return yamlError(walked.error, text);
  return found;
}

/** `_check`: aliases (a node reached twice), custom tags, merge keys, non-text and duplicate keys. */
function check(root: YamlNode): YamlTreeError | null {
  const seen = new Set<YamlNode>();
  const stack: YamlNode[] = [root];
  const at = (node: YamlNode, message: string): YamlTreeError => {
    const [line, column] = position(node);
    return { message, line, column };
  };
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (seen.has(node)) return at(node, "YAML anchors and aliases (& and *) are not supported");
    seen.add(node);
    if (node.kind === "scalar") {
      if (!SCALAR_TAGS.has(node.tag)) return at(node, `Unsupported YAML tag ${node.tag}`);
    } else if (node.kind === "sequence") {
      if (node.tag !== SEQ_TAG) return at(node, `Unsupported YAML tag ${node.tag}`);
      stack.push(...node.value);
    } else {
      if (node.tag !== MAP_TAG) return at(node, `Unsupported YAML tag ${node.tag}`);
      const firstLines = new Map<string, number>();
      for (const [keyNode, valueNode] of node.value) {
        if (keyNode.kind === "scalar" && keyNode.tag === MERGE_TAG) {
          return at(keyNode, "YAML merge keys (<<) are not supported");
        }
        if (keyNode.kind !== "scalar") return at(keyNode, "Mapping keys must be plain text");
        const key = keyNode.value;
        const first = firstLines.get(key);
        if (first !== undefined) {
          return at(
            keyNode,
            `Invalid YAML: duplicate mapping key "${key}" (first defined on line ${first})`,
          );
        }
        firstLines.set(key, position(keyNode)[0]);
        stack.push(keyNode, valueNode);
      }
    }
  }
  return null;
}

/** 1-based (line, column) of the node's start. */
export function position(node: YamlNode): readonly [number, number] {
  return [node.startMark.line + 1, node.startMark.column + 1];
}

/** Absent or explicit YAML null (`key:` with nothing after it). */
export function isAbsent(node: YamlNode | null | undefined): node is null | undefined {
  return node == null || (node.kind === "scalar" && node.tag === NULL_TAG);
}

/** Text of a key node (`key_node.value`; every key is a scalar once `compose` accepted the tree). */
function keyText(node: YamlNode): string {
  return node.kind === "scalar" ? node.value : "";
}

export function entries(node: MappingNode): Entry[] {
  return node.value.map(([keyNode, value]) => ({ key: keyText(keyNode), keyNode, value }));
}

/** The value node of `key` in `node`, or null. */
export function get(node: MappingNode, key: string): YamlNode | null {
  for (const [keyNode, value] of node.value) if (keyText(keyNode) === key) return value;
  return null;
}

export { plainMap, toPlain } from "../../pyYaml/plainTree.js";

/** The steps of a `locate` key (`a.b`, `tags[1]`), or null when an index is not a number. */
function locateSteps(key: string): (string | number)[] | null {
  const steps: (string | number)[] = [];
  for (const part of key.split(".")) {
    const bracket = part.indexOf("[");
    const name = bracket < 0 ? part : part.slice(0, bracket);
    const rest = bracket < 0 ? "" : part.slice(bracket + 1);
    if (name) steps.push(name);
    if (!rest) continue;
    for (const index of `[${rest}`.split("[").slice(1)) {
      const digits = index.replace(/\]+$/u, "");
      const cps = Array.from(digits);
      if (cps.length === 0 || !cps.every((ch) => pyIsDigit(ch.codePointAt(0) ?? 0))) return null;
      // str.isdigit admits digits int() refuses (superscripts): Python raises there; treat as no index
      const values = cps.map((ch) => unicodeDecimal(ch.codePointAt(0) ?? 0));
      if (values.some((v) => v < 0)) return null;
      steps.push(Number(values.join("")));
    }
  }
  return steps;
}

/**
 * `locate`: the node at `key` (`threshold`, `asset_class[1]`, `a.b`) below `base`. For the last mapping
 * key: the key node itself when `keyNode` (unknown-key warnings), else its value. Falls back to the
 * deepest node found; null when not even the first step resolves.
 */
export function locate(base: YamlNode, key: string, keyNode: boolean): YamlNode | null {
  if (!key) return base;
  const steps = locateSteps(key);
  if (steps === null) return null;
  let current: YamlNode = base;
  let found: YamlNode | null = null;
  for (const [i, step] of steps.entries()) {
    let following: YamlNode | null = null;
    if (typeof step === "string" && current.kind === "mapping") {
      for (const [candidate, value] of current.value) {
        if (keyText(candidate) === step) {
          following = keyNode && i === steps.length - 1 ? candidate : value;
          break;
        }
      }
    } else if (typeof step === "number" && current.kind === "sequence") {
      following = current.value[step] ?? null;
    }
    if (following === null) return found;
    found = following;
    current = following;
  }
  return found;
}

/**
 * `exact_column`: 1-based column of character `offset` of a single-line scalar's text, when the YAML
 * source shows that text verbatim (plain or quoted without escapes); null otherwise. `source` is the
 * document's code points (marks index code points).
 */
export function exactColumn(
  source: readonly string[],
  node: YamlNode,
  offset: number,
): number | null {
  if (node.kind !== "scalar" || node.startMark.line !== node.endMark.line) return null;
  const quote = node.style === "'" || node.style === '"' ? 1 : 0;
  const start = node.startMark.index + quote;
  const value = Array.from(node.value);
  const shown = source.slice(start, start + value.length);
  if (shown.length !== value.length || shown.some((ch, i) => ch !== value[i])) return null;
  return node.startMark.column + 1 + quote + offset;
}
