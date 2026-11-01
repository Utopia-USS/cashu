/**
 * PyYAML's `Composer` (`composer.py`): events to the node graph, anchors and aliases (an alias is
 * the anchored node object itself, so a collection may contain itself), one document only. Python
 * recurses per nesting level; this walks an explicit stack, so no input can overflow the call stack
 * (where Python would raise `RecursionError` the port composes the document).
 */

import { pyReprStr } from "../pyRepr.js";
import { markedError, type YamlMark } from "./errors.js";
import type { Parser, YamlEvent } from "./parser.js";
import { DEFAULT_MAPPING_TAG, DEFAULT_SEQUENCE_TAG, resolveScalar } from "./resolver.js";

export interface YamlScalarNode {
  readonly kind: "scalar";
  readonly tag: string;
  readonly value: string;
  readonly startMark: YamlMark;
  readonly endMark: YamlMark;
  /** `null` (plain), `'`, `"`, `|` or `>`. */
  readonly style: string | null;
}

interface YamlSequenceNode {
  readonly kind: "sequence";
  readonly tag: string;
  readonly value: readonly YamlNode[];
  readonly startMark: YamlMark;
  readonly endMark: YamlMark;
  readonly flowStyle: boolean | null;
}

interface YamlMappingNode {
  readonly kind: "mapping";
  readonly tag: string;
  readonly value: readonly (readonly [YamlNode, YamlNode])[];
  readonly startMark: YamlMark;
  readonly endMark: YamlMark;
  readonly flowStyle: boolean | null;
}

export type YamlNode = YamlScalarNode | YamlSequenceNode | YamlMappingNode;

/** A collection while its children are composed (`end_mark` is set by its end event). */
interface OpenSequence {
  readonly kind: "sequence";
  readonly tag: string;
  readonly value: YamlNode[];
  readonly startMark: YamlMark;
  endMark: YamlMark;
  readonly flowStyle: boolean | null;
}

interface OpenMapping {
  readonly kind: "mapping";
  readonly tag: string;
  readonly value: (readonly [YamlNode, YamlNode])[];
  readonly startMark: YamlMark;
  endMark: YamlMark;
  readonly flowStyle: boolean | null;
}

/** One open collection; a mapping remembers a composed key waiting for its value. */
type Frame = { readonly node: OpenSequence } | { readonly node: OpenMapping; key: YamlNode | null };

type ScalarEvent = Extract<YamlEvent, { kind: "Scalar" }>;
type CollectionStartEvent = Extract<YamlEvent, { kind: "SequenceStart" | "MappingStart" }>;

export class Composer {
  private readonly parser: Parser;
  private readonly anchors = new Map<string, YamlNode>();

  constructor(parser: Parser) {
    this.parser = parser;
  }

  /** `get_single_node()`: the root of the only document, `null` for an empty stream. */
  getSingleNode(): YamlNode | null {
    const parser = this.parser;
    // Drop the STREAM-START event.
    parser.getEvent();
    let document: YamlNode | null = null;
    if (!parser.checkEvent("StreamEnd")) document = this.composeDocument();
    // Ensure that the stream contains no more documents.
    if (!parser.checkEvent("StreamEnd")) {
      const event = parser.getEvent();
      throw markedError(
        "expected a single document in the stream",
        document?.startMark ?? null,
        "but found another document",
        event.startMark,
      );
    }
    // Drop the STREAM-END event.
    parser.getEvent();
    return document;
  }

  private composeDocument(): YamlNode {
    this.parser.getEvent();
    const node = this.composeNode();
    this.parser.getEvent();
    this.anchors.clear();
    return node;
  }

  /** `compose_node(None, None)` and everything below it. */
  private composeNode(): YamlNode {
    const parser = this.parser;
    const stack: Frame[] = [];
    for (;;) {
      // Start the next node (`compose_node`).
      let done: YamlNode | null = null;
      if (parser.checkEvent("Alias")) {
        const event = parser.getEvent();
        const anchor = event.kind === "Alias" ? event.anchor : "";
        const target = this.anchors.get(anchor);
        if (target === undefined) {
          throw markedError(
            null,
            null,
            `found undefined alias ${pyReprStr(anchor)}`,
            event.startMark,
          );
        }
        done = target;
      } else {
        const event = parser.peekEvent();
        if (
          event === null ||
          (event.kind !== "Scalar" &&
            event.kind !== "SequenceStart" &&
            event.kind !== "MappingStart")
        ) {
          throw new Error(`pyYaml composer: ${event?.kind ?? "no event"} where a node starts`);
        }
        const anchor = event.anchor;
        if (anchor !== null) {
          const first = this.anchors.get(anchor);
          if (first !== undefined) {
            throw markedError(
              `found duplicate anchor ${pyReprStr(anchor)}; first occurrence`,
              first.startMark,
              "second occurrence",
              event.startMark,
            );
          }
        }
        parser.getEvent();
        if (event.kind === "Scalar") done = this.composeScalar(event);
        else stack.push(this.openCollection(event));
      }
      // Attach finished nodes to their parents and close collections whose end event is next.
      for (;;) {
        const top = stack[stack.length - 1];
        if (done !== null) {
          if (top === undefined) return done;
          if (!("key" in top)) {
            top.node.value.push(done);
          } else if (top.key === null) {
            top.key = done;
          } else {
            top.node.value.push([top.key, done]);
            top.key = null;
          }
          done = null;
          continue;
        }
        if (top === undefined) throw new Error("pyYaml composer: no open collection");
        // A mapping composes the value right after the key, without looking for its end.
        if ("key" in top && top.key !== null) break;
        if (!parser.checkEvent(top.node.kind === "sequence" ? "SequenceEnd" : "MappingEnd")) break;
        top.node.endMark = parser.getEvent().endMark;
        stack.pop();
        done = top.node;
      }
    }
  }

  private composeScalar(event: ScalarEvent): YamlScalarNode {
    const tag =
      event.tag === null || event.tag === "!"
        ? resolveScalar(event.value, event.implicit)
        : event.tag;
    const node: YamlScalarNode = {
      kind: "scalar",
      tag,
      value: event.value,
      startMark: event.startMark,
      endMark: event.endMark,
      style: event.style,
    };
    if (event.anchor !== null) this.anchors.set(event.anchor, node);
    return node;
  }

  /** The node of a SEQUENCE-START / MAPPING-START, anchored before its children are composed. */
  private openCollection(event: CollectionStartEvent): Frame {
    // `None` and the non-specific `!` resolve to the default tag (no path resolvers).
    const tag = event.tag === null || event.tag === "!" ? null : event.tag;
    let frame: Frame;
    if (event.kind === "SequenceStart") {
      frame = {
        node: {
          kind: "sequence",
          tag: tag ?? DEFAULT_SEQUENCE_TAG,
          value: [],
          startMark: event.startMark,
          endMark: event.startMark,
          flowStyle: event.flowStyle,
        },
      };
    } else {
      frame = {
        node: {
          kind: "mapping",
          tag: tag ?? DEFAULT_MAPPING_TAG,
          value: [],
          startMark: event.startMark,
          endMark: event.startMark,
          flowStyle: event.flowStyle,
        },
        key: null,
      };
    }
    if (event.anchor !== null) this.anchors.set(event.anchor, frame.node);
    return frame;
  }
}
