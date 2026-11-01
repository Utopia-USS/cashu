/**
 * A composed node tree as Python values (`plain.ts`), in the two ways the Python code builds them:
 *
 * - `toPlain` / `plainMap`: `strategy/yaml_tree.py` `to_plain` over a tree `compose` already checked
 *   (keys are the key scalars' text, a scalar that fails to construct stays text);
 * - `safeLoadYaml`: `yaml.safe_load(text)` (PyYAML 6.0.3 `SafeConstructor`): keys are constructed
 *   too, merge keys (`<<`) are flattened, and where Python raises a `yaml.YAMLError` (a parse error,
 *   a `ConstructorError`: an unknown tag, an unhashable key, a scalar that does not construct) the
 *   result is `{ ok: false }`. Nothing throws.
 *
 * Both walk the tree with one builder; only the key, merge and failure policy differ.
 *
 * Deliberate differences of `safeLoadYaml` (each an `ok: false` here where Python builds a value):
 * the `!!set`, `!!omap`, `!!pairs` and `!!binary` tags (no Python value model for them) and a
 * collection that contains itself through an alias. Mapping keys come out as `str(key)`; keys Python
 * treats as one (`1`, `1.0`, `True`) are folded the same way (first key kept, last value wins).
 */

import { constructScalar } from "./constructor.js";
import { composeYaml, type YamlError, type YamlNode } from "./index.js";
import { PyDate, PyDateTime, type PyPlain, type PyPlainMap, pyStr } from "./plain.js";

const SCALAR_TAGS: ReadonlySet<string> = new Set([
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:timestamp",
]);
const STR_TAG = "tag:yaml.org,2002:str";
const MAP_TAG = "tag:yaml.org,2002:map";
const SEQ_TAG = "tag:yaml.org,2002:seq";
const MERGE_TAG = "tag:yaml.org,2002:merge";
const VALUE_TAG = "tag:yaml.org,2002:value";

type MappingNode = Extract<YamlNode, { kind: "mapping" }>;
type Pair = readonly [YamlNode, YamlNode];

/** `yaml.safe_load` raised: the compose error, or a construct problem (`error: null`). */
export type SafeLoadResult =
  | { readonly ok: true; readonly value: PyPlain }
  | { readonly ok: false; readonly error: YamlError | null };

/** Where `SafeConstructor` raises a `ConstructorError` (internal: becomes `{ ok: false }`). */
class ConstructFailure extends Error {}

/** `to_plain`: the Python value of `node` (a str-tagged scalar stays text; a failed construct too). */
export function toPlain(node: YamlNode): PyPlain {
  return build(node, LENIENT, new Set());
}

/** `to_plain` of a mapping node (`{key_node.value: to_plain(value_node)}`). */
export function plainMap(node: MappingNode): PyPlainMap {
  return buildMap(node, LENIENT, new Set());
}

/** `yaml.safe_load(text)`: null for an empty document. */
export function safeLoadYaml(text: string): SafeLoadResult {
  const composed = composeYaml(text);
  if (!composed.ok) return { ok: false, error: composed.error };
  if (composed.node === null) return { ok: true, value: null };
  try {
    return { ok: true, value: build(composed.node, SAFE, new Set()) };
  } catch (error) {
    if (!(error instanceof ConstructFailure)) throw error;
    return { ok: false, error: null };
  }
}

interface Policy {
  /** `yaml.safe_load`: unknown tags / failed scalars raise, keys are constructed, merges flattened. */
  readonly safe: boolean;
}
const LENIENT: Policy = { safe: false };
const SAFE: Policy = { safe: true };

function build(node: YamlNode, policy: Policy, open: Set<YamlNode>): PyPlain {
  if (node.kind === "scalar") {
    if (node.tag === STR_TAG) return node.value;
    if (policy.safe && !SCALAR_TAGS.has(node.tag)) throw new ConstructFailure();
    const built = constructScalar(node);
    if (built.ok) return built.value;
    if (policy.safe) throw new ConstructFailure();
    return node.value;
  }
  if (policy.safe) {
    if (open.has(node)) throw new ConstructFailure(); // a collection inside itself (an alias)
    if (node.tag !== (node.kind === "sequence" ? SEQ_TAG : MAP_TAG)) throw new ConstructFailure();
  }
  open.add(node);
  try {
    if (node.kind === "sequence") return node.value.map((child) => build(child, policy, open));
    return buildMap(node, policy, open);
  } finally {
    open.delete(node);
  }
}

function buildMap(node: MappingNode, policy: Policy, open: Set<YamlNode>): PyPlainMap {
  const out = new Map<string, PyPlain>();
  if (!policy.safe) {
    for (const [keyNode, value] of node.value) {
      out.set(keyNode.kind === "scalar" ? keyNode.value : "", build(value, policy, open));
    }
    return out;
  }
  // `construct_mapping`: Python dict semantics over the constructed keys (equal keys share one
  // entry: the first key stays, the last value wins), then `str(key)` for this map's text keys.
  const entries = new Map<string, { key: string; value: PyPlain }>();
  for (const [index, [keyNode, valueNode]] of flatten(node, open).entries()) {
    if (keyNode.kind !== "scalar") throw new ConstructFailure(); // an unhashable key
    const key = build(keyNode, policy, open);
    const identity = keyIdentity(key) ?? `nan:${index}`;
    const value = build(valueNode, policy, open);
    const known = entries.get(identity);
    entries.set(identity, { key: known?.key ?? pyStr(key), value });
  }
  for (const { key, value } of entries.values()) out.set(key, value);
  return out;
}

/**
 * `SafeConstructor.flatten_mapping`: the pairs of `node` with every `<<` merge expanded (a mapping, or
 * a sequence of mappings: later ones first, so earlier ones win), merged pairs before the node's own;
 * a `=` value key reads as text. Anything else under `<<` raises.
 */
function flatten(node: MappingNode, open: Set<YamlNode>): Pair[] {
  const merge: Pair[] = [];
  const own: Pair[] = [];
  for (const [keyNode, valueNode] of node.value) {
    if (keyNode.kind === "scalar" && keyNode.tag === MERGE_TAG) {
      if (valueNode.kind === "mapping") {
        merge.push(...flattenChild(valueNode, open));
      } else if (valueNode.kind === "sequence") {
        const parts: Pair[][] = [];
        for (const sub of valueNode.value) {
          if (sub.kind !== "mapping") throw new ConstructFailure();
          parts.push(flattenChild(sub, open));
        }
        for (const part of parts.reverse()) merge.push(...part);
      } else {
        throw new ConstructFailure();
      }
    } else if (keyNode.kind === "scalar" && keyNode.tag === VALUE_TAG) {
      own.push([{ ...keyNode, tag: STR_TAG }, valueNode]);
    } else {
      own.push([keyNode, valueNode]);
    }
  }
  return [...merge, ...own];
}

function flattenChild(node: MappingNode, open: Set<YamlNode>): Pair[] {
  if (open.has(node)) throw new ConstructFailure();
  open.add(node);
  try {
    return flatten(node, open);
  } finally {
    open.delete(node);
  }
}

/** Python `hash` / `==` classes of a scalar key (`1 == 1.0 == True`); null for NaN (equal to nothing). */
function keyIdentity(key: PyPlain): string | null {
  if (key === null) return "none";
  if (typeof key === "string") return `s:${key}`;
  if (typeof key === "boolean") return key ? "n:1" : "n:0";
  if (typeof key === "bigint") return `n:${key}`;
  if (typeof key === "number") {
    if (Number.isNaN(key)) return null;
    if (!Number.isFinite(key)) return key > 0 ? "n:inf" : "n:-inf";
    return Number.isInteger(key) ? `n:${BigInt(key)}` : `n:${key}`;
  }
  if (key instanceof PyDateTime) return `dt:${key.isoformat(" ")}`;
  if (key instanceof PyDate) return `d:${key.isoformat()}`;
  throw new ConstructFailure(); // a list or map key is unhashable
}
