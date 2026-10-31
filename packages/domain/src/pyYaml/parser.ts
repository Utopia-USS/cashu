/**
 * PyYAML's `Parser` (`parser.py`): the LL(1) state machine turning tokens into events, with the
 * `%YAML` / `%TAG` directives and tag handle resolution. States are bound functions on a stack, as
 * in Python, so nesting costs heap, not call stack.
 */

import { pyReprStr } from "../pyRepr.js";
import { markedError, type YamlMark } from "./errors.js";
import { marksOf, processEmptyScalar, type State, type YamlEvent } from "./events.js";
import { CollectionStates } from "./parseCollections.js";
import type { Scanner } from "./scanner.js";
import type { Token } from "./tokens.js";

export type { YamlEvent } from "./events.js";

const DEFAULT_TAGS: ReadonlyMap<string, string> = new Map([
  ["!", "!"],
  ["!!", "tag:yaml.org,2002:"],
]);

export class Parser {
  readonly scanner: Scanner;
  private currentEvent: YamlEvent | null = null;
  private yamlVersion: readonly [number, number] | null = null;
  private tagHandles: ReadonlyMap<string, string> = new Map();
  /** The states to return to (`states`) and the start marks of open collections (`marks`). */
  readonly states: State[] = [];
  readonly marks: YamlMark[] = [];
  state: State | null;
  private readonly collections = new CollectionStates(this);

  constructor(scanner: Scanner) {
    this.scanner = scanner;
    this.state = this.parseStreamStart;
  }

  /** `check_event(*choices)`. */
  checkEvent(...choices: readonly YamlEvent["kind"][]): boolean {
    const event = this.peekEvent();
    if (event === null) return false;
    return choices.length === 0 || choices.includes(event.kind);
  }

  /** `peek_event()`: `null` once the stream is over. */
  peekEvent(): YamlEvent | null {
    if (this.currentEvent === null && this.state !== null) this.currentEvent = this.state();
    return this.currentEvent;
  }

  /** `get_event()`. The composer never asks past STREAM-END. */
  getEvent(): YamlEvent {
    const event = this.peekEvent();
    if (event === null) throw new Error("pyYaml parser: no event after the stream end");
    this.currentEvent = null;
    return event;
  }

  popState(): State {
    const state = this.states.pop();
    if (state === undefined) throw new Error("pyYaml parser: state stack underflow");
    return state;
  }

  // stream ::= STREAM-START implicit_document? explicit_document* STREAM-END

  private readonly parseStreamStart: State = () => {
    const token = this.scanner.getToken();
    this.state = this.parseImplicitDocumentStart;
    return { kind: "StreamStart", startMark: token.startMark, endMark: token.endMark };
  };

  private readonly parseImplicitDocumentStart: State = () => {
    if (!this.scanner.checkToken("<directive>", "<document start>", "<stream end>")) {
      this.tagHandles = DEFAULT_TAGS;
      const mark = this.scanner.peekToken().startMark;
      this.states.push(this.parseDocumentEnd);
      this.state = this.parseBlockNode;
      return { kind: "DocumentStart", explicit: false, startMark: mark, endMark: mark };
    }
    return this.parseDocumentStart();
  };

  private readonly parseDocumentStart: State = () => {
    // Parse any extra document end indicators.
    while (this.scanner.checkToken("<document end>")) this.scanner.getToken();
    if (!this.scanner.checkToken("<stream end>")) {
      const startMark = this.scanner.peekToken().startMark;
      this.processDirectives();
      if (!this.scanner.checkToken("<document start>")) {
        const next = this.scanner.peekToken();
        throw markedError(
          null,
          null,
          `expected '<document start>', but found ${pyReprStr(next.id)}`,
          next.startMark,
        );
      }
      const token = this.scanner.getToken();
      this.states.push(this.parseDocumentEnd);
      this.state = this.parseDocumentContent;
      return { kind: "DocumentStart", explicit: true, startMark, endMark: token.endMark };
    }
    const token = this.scanner.getToken();
    this.state = null;
    return { kind: "StreamEnd", startMark: token.startMark, endMark: token.endMark };
  };

  private readonly parseDocumentEnd: State = () => {
    const startMark = this.scanner.peekToken().startMark;
    let endMark = startMark;
    let explicit = false;
    if (this.scanner.checkToken("<document end>")) {
      endMark = this.scanner.getToken().endMark;
      explicit = true;
    }
    this.state = this.parseDocumentStart;
    return { kind: "DocumentEnd", explicit, startMark, endMark };
  };

  private readonly parseDocumentContent: State = () => {
    if (
      this.scanner.checkToken("<directive>", "<document start>", "<document end>", "<stream end>")
    ) {
      const event = processEmptyScalar(this.scanner.peekToken().startMark);
      this.state = this.popState();
      return event;
    }
    return this.parseBlockNode();
  };

  private processDirectives(): void {
    this.yamlVersion = null;
    const handles = new Map<string, string>();
    this.tagHandles = handles;
    while (this.scanner.checkToken("<directive>")) {
      const token = this.scanner.getToken();
      if (token.id !== "<directive>") continue;
      const value = token.value;
      if (token.name === "YAML" && value?.kind === "yaml") {
        if (this.yamlVersion !== null) {
          throw markedError(null, null, "found duplicate YAML directive", token.startMark);
        }
        if (value.major !== 1) {
          throw markedError(
            null,
            null,
            "found incompatible YAML document (version 1.* is required)",
            token.startMark,
          );
        }
        this.yamlVersion = [value.major, value.minor];
      } else if (token.name === "TAG" && value?.kind === "tag") {
        if (handles.has(value.handle)) {
          throw markedError(
            null,
            null,
            `duplicate tag handle ${pyReprStr(value.handle)}`,
            token.startMark,
          );
        }
        handles.set(value.handle, value.prefix);
      }
    }
    for (const [key, prefix] of DEFAULT_TAGS) {
      if (!handles.has(key)) handles.set(key, prefix);
    }
  }

  // block_node ::= ALIAS | properties? (block_content | indentless_sequence)?
  // flow_node  ::= ALIAS | properties? flow_content?

  readonly parseBlockNode: State = () => this.parseNode(true, false);
  readonly parseFlowNode: State = () => this.parseNode(false, false);
  readonly parseBlockNodeOrIndentlessSequence: State = () => this.parseNode(true, true);

  private parseNode(block: boolean, indentlessSequence: boolean): YamlEvent {
    const scanner = this.scanner;
    if (scanner.checkToken("<alias>")) {
      const token = scanner.getToken();
      this.state = this.popState();
      return { kind: "Alias", anchor: tokenValue(token), ...marksOf(token) };
    }
    let anchor: string | null = null;
    let rawTag: readonly [string | null, string] | null = null;
    let startMark: YamlMark | null = null;
    let endMark: YamlMark | null = null;
    let tagMark: YamlMark | null = null;
    if (scanner.checkToken("<anchor>")) {
      const token = scanner.getToken();
      startMark = token.startMark;
      endMark = token.endMark;
      anchor = tokenValue(token);
      if (scanner.checkToken("<tag>")) {
        const tagToken = scanner.getToken();
        tagMark = tagToken.startMark;
        endMark = tagToken.endMark;
        rawTag = tagValue(tagToken);
      }
    } else if (scanner.checkToken("<tag>")) {
      const token = scanner.getToken();
      startMark = tagMark = token.startMark;
      endMark = token.endMark;
      rawTag = tagValue(token);
      if (scanner.checkToken("<anchor>")) {
        const anchorToken = scanner.getToken();
        endMark = anchorToken.endMark;
        anchor = tokenValue(anchorToken);
      }
    }
    let tag: string | null = null;
    if (rawTag !== null) {
      const [handle, suffix] = rawTag;
      if (handle !== null) {
        const prefix = this.tagHandles.get(handle);
        if (prefix === undefined) {
          throw markedError(
            "while parsing a node",
            startMark,
            `found undefined tag handle ${pyReprStr(handle)}`,
            tagMark,
          );
        }
        tag = prefix + suffix;
      } else {
        tag = suffix;
      }
    }
    if (startMark === null || endMark === null) {
      startMark = endMark = scanner.peekToken().startMark;
    }
    const implicit = tag === null || tag === "!";
    if (indentlessSequence && scanner.checkToken("-")) {
      endMark = scanner.peekToken().endMark;
      this.state = this.collections.parseIndentlessSequenceEntry;
      return { kind: "SequenceStart", anchor, tag, implicit, flowStyle: null, startMark, endMark };
    }
    if (scanner.checkToken("<scalar>")) {
      const token = scanner.getToken();
      if (token.id !== "<scalar>") throw new Error("pyYaml parser: scalar token expected");
      const scalarImplicit: readonly [boolean, boolean] =
        (token.plain && tag === null) || tag === "!"
          ? [true, false]
          : tag === null
            ? [false, true]
            : [false, false];
      this.state = this.popState();
      return {
        kind: "Scalar",
        anchor,
        tag,
        implicit: scalarImplicit,
        value: token.value,
        style: token.style,
        startMark,
        endMark: token.endMark,
      };
    }
    const collection = (
      kind: "SequenceStart" | "MappingStart",
      flowStyle: boolean,
      end: YamlMark,
      next: State,
    ): YamlEvent => {
      this.state = next;
      return { kind, anchor, tag, implicit, flowStyle, startMark, endMark: end };
    };
    if (scanner.checkToken("[")) {
      return collection(
        "SequenceStart",
        true,
        scanner.peekToken().endMark,
        this.collections.parseFlowSequenceFirstEntry,
      );
    }
    if (scanner.checkToken("{")) {
      return collection(
        "MappingStart",
        true,
        scanner.peekToken().endMark,
        this.collections.parseFlowMappingFirstKey,
      );
    }
    if (block && scanner.checkToken("<block sequence start>")) {
      return collection(
        "SequenceStart",
        false,
        scanner.peekToken().startMark,
        this.collections.parseBlockSequenceFirstEntry,
      );
    }
    if (block && scanner.checkToken("<block mapping start>")) {
      return collection(
        "MappingStart",
        false,
        scanner.peekToken().startMark,
        this.collections.parseBlockMappingFirstKey,
      );
    }
    if (anchor !== null || tag !== null) {
      // Empty scalar with properties only.
      this.state = this.popState();
      return {
        kind: "Scalar",
        anchor,
        tag,
        implicit: [implicit, false],
        value: "",
        style: null,
        startMark,
        endMark,
      };
    }
    const token = scanner.peekToken();
    throw markedError(
      `while parsing a ${block ? "block" : "flow"} node`,
      startMark,
      `expected the node content, but found ${pyReprStr(token.id)}`,
      token.startMark,
    );
  }
}

/** The value of an ALIAS / ANCHOR token (the parser checked the kind just before). */
function tokenValue(token: Token): string {
  if (token.id !== "<alias>" && token.id !== "<anchor>") {
    throw new Error(`pyYaml parser: ${token.id} has no name`);
  }
  return token.value;
}

function tagValue(token: Token): readonly [string | null, string] {
  if (token.id !== "<tag>") throw new Error(`pyYaml parser: ${token.id} is not a tag`);
  return token.value;
}
