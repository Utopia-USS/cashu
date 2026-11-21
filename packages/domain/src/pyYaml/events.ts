/**
 * PyYAML's `events.py` (only what the composer reads) and the small helpers both parser files use.
 */

import type { YamlMark } from "./errors.js";
import type { ScalarStyle, Token } from "./tokens.js";

export interface Marks {
  readonly startMark: YamlMark;
  readonly endMark: YamlMark;
}

/** `events.py` (only what the composer reads). */
export type YamlEvent =
  | (Marks & { readonly kind: "StreamStart" | "StreamEnd" | "SequenceEnd" | "MappingEnd" })
  | (Marks & { readonly kind: "DocumentStart" | "DocumentEnd"; readonly explicit: boolean })
  | (Marks & { readonly kind: "Alias"; readonly anchor: string })
  | (Marks & {
      readonly kind: "Scalar";
      readonly anchor: string | null;
      readonly tag: string | null;
      /** `(plain_implicit, quoted_implicit)`. */
      readonly implicit: readonly [boolean, boolean];
      readonly value: string;
      readonly style: ScalarStyle;
    })
  | (Marks & {
      readonly kind: "SequenceStart" | "MappingStart";
      readonly anchor: string | null;
      readonly tag: string | null;
      readonly implicit: boolean;
      readonly flowStyle: boolean | null;
    });

/** A parser state: produces the next event (PyYAML keeps bound methods on a stack). */
export type State = () => YamlEvent;

/** `process_empty_scalar(mark)`: an empty plain scalar. */
export function processEmptyScalar(mark: YamlMark): YamlEvent {
  return {
    kind: "Scalar",
    anchor: null,
    tag: null,
    implicit: [true, false],
    value: "",
    style: null,
    startMark: mark,
    endMark: mark,
  };
}

export function marksOf(token: Token): Marks {
  return { startMark: token.startMark, endMark: token.endMark };
}
