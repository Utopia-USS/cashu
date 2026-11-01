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
import type { YamlEvent } from "./events.js";
import { Parser } from "./parser.js";
import { Reader } from "./reader.js";
import { Scanner } from "./scanner.js";

export type { YamlNode } from "./composer.js";
export type { YamlError, YamlMark } from "./errors.js";
export type { YamlEvent } from "./events.js";

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

/**
 * `for event in yaml.parse(text, Loader=yaml.SafeLoader)`: hands each event to `visit` in stream order
 * until the stream ends or `visit` returns `false` (the caller stopped, like a `raise` inside the
 * Python loop). A scanner / parser error ends the walk as an error result, at the point Python raises.
 */
export function walkYamlEvents(
  text: string,
  visit: (event: YamlEvent) => boolean,
): { readonly ok: true } | { readonly ok: false; readonly error: YamlError } {
  let reader: Reader | null = null;
  try {
    reader = new Reader(text);
    const parser = new Parser(new Scanner(reader));
    while (parser.peekEvent() !== null) {
      const event = parser.getEvent();
      if (!visit(event)) return { ok: true };
      if (event.kind === "StreamEnd") break;
    }
    return { ok: true };
  } catch (error) {
    if (!(error instanceof YamlFailure)) throw error;
    return { ok: false, error: renderError(error.detail, reader?.buffer ?? []) };
  }
}
