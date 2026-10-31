/**
 * `yaml.compose(text, Loader=yaml.SafeLoader)`: a port of PyYAML 6.0.3 (MIT) - the `str`-input
 * Reader, the Scanner, the Parser, the Composer and the SafeLoader's YAML 1.1 implicit resolvers -
 * with PyYAML's node graph, marks (code points) and error texts. Errors are returned, never thrown.
 * Checked against Python by `pyYaml.test.ts` and `pyYaml.vectors.exhaustive.test.ts`
 * (`yaml-*.jsonl`, written by `parity/python/vectors_yaml.py`).
 *
 * Deliberate differences, only where Python raises a non-YAML exception that `yaml.compose` lets
 * escape: a `\U` escape above U+10FFFF (`ValueError` from `chr()`) is a scanner error here, a
 * `%YAML` version number over 4300 digits (`ValueError` from `int()`) is read as a number, and
 * nesting deeper than Python's recursion limit (`RecursionError`, about 500 levels) is composed.
 */

import { Composer, type YamlNode } from "./composer.js";
import { renderError, type YamlError, YamlFailure } from "./errors.js";
import { Parser } from "./parser.js";
import { Reader } from "./reader.js";
import { Scanner } from "./scanner.js";

export type {
  YamlMappingNode,
  YamlNode,
  YamlScalarNode,
  YamlSequenceNode,
} from "./composer.js";
export type { YamlError, YamlMark } from "./errors.js";

export type YamlComposeResult =
  | { readonly ok: true; readonly node: YamlNode | null }
  | { readonly ok: false; readonly error: YamlError };

/** `yaml.compose(text, Loader=yaml.SafeLoader)`. */
export function composeYaml(text: string): YamlComposeResult {
  let reader: Reader | null = null;
  try {
    reader = new Reader(text);
    const node = new Composer(new Parser(new Scanner(reader))).getSingleNode();
    return { ok: true, node };
  } catch (error) {
    if (!(error instanceof YamlFailure)) throw error;
    return { ok: false, error: renderError(error.detail, reader?.buffer ?? []) };
  }
}
