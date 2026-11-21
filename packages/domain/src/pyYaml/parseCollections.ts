/**
 * The collection states of PyYAML's `Parser` (`parser.py`): block sequences (indentless ones too),
 * block mappings, flow sequences (with their single-pair mappings) and flow mappings.
 */

import { pyReprStr } from "../pyRepr.js";
import { markedError, type YamlMark } from "./errors.js";
import { marksOf, processEmptyScalar, type State, type YamlEvent } from "./events.js";
import type { Scanner } from "./scanner.js";

/** What the collection states read and change of the `Parser`. */
export interface ParserCore {
  readonly scanner: Scanner;
  readonly states: State[];
  readonly marks: YamlMark[];
  state: State | null;
  popState(): State;
  readonly parseBlockNode: State;
  readonly parseFlowNode: State;
  readonly parseBlockNodeOrIndentlessSequence: State;
}

export class CollectionStates {
  private readonly p: ParserCore;

  constructor(parser: ParserCore) {
    this.p = parser;
  }

  private lastMark(): YamlMark | null {
    return this.p.marks[this.p.marks.length - 1] ?? null;
  }

  // block_sequence ::= BLOCK-SEQUENCE-START (BLOCK-ENTRY block_node?)* BLOCK-END

  readonly parseBlockSequenceFirstEntry: State = () => {
    this.p.marks.push(this.p.scanner.getToken().startMark);
    return this.parseBlockSequenceEntry();
  };

  readonly parseBlockSequenceEntry: State = () => {
    const scanner = this.p.scanner;
    if (scanner.checkToken("-")) {
      const token = scanner.getToken();
      if (!scanner.checkToken("-", "<block end>")) {
        this.p.states.push(this.parseBlockSequenceEntry);
        return this.p.parseBlockNode();
      }
      this.p.state = this.parseBlockSequenceEntry;
      return processEmptyScalar(token.endMark);
    }
    return this.parseBlockEnd("while parsing a block collection", "SequenceEnd");
  };

  /** BLOCK-END closing a block collection, or the "expected <block end>" error. */
  parseBlockEnd(context: string, kind: "SequenceEnd" | "MappingEnd"): YamlEvent {
    const scanner = this.p.scanner;
    if (!scanner.checkToken("<block end>")) {
      const token = scanner.peekToken();
      throw markedError(
        context,
        this.lastMark(),
        `expected <block end>, but found ${pyReprStr(token.id)}`,
        token.startMark,
      );
    }
    const token = scanner.getToken();
    this.p.state = this.p.popState();
    this.p.marks.pop();
    return { kind, ...marksOf(token) };
  }

  // indentless_sequence ::= (BLOCK-ENTRY block_node?)+

  readonly parseIndentlessSequenceEntry: State = () => {
    const scanner = this.p.scanner;
    if (scanner.checkToken("-")) {
      const token = scanner.getToken();
      if (!scanner.checkToken("-", "?", ":", "<block end>")) {
        this.p.states.push(this.parseIndentlessSequenceEntry);
        return this.p.parseBlockNode();
      }
      this.p.state = this.parseIndentlessSequenceEntry;
      return processEmptyScalar(token.endMark);
    }
    const mark = scanner.peekToken().startMark;
    this.p.state = this.p.popState();
    return { kind: "SequenceEnd", startMark: mark, endMark: mark };
  };

  // block_mapping ::= BLOCK-MAPPING_START ((KEY block_node_or_indentless_sequence?)?
  //                   (VALUE block_node_or_indentless_sequence?)?)* BLOCK-END

  readonly parseBlockMappingFirstKey: State = () => {
    this.p.marks.push(this.p.scanner.getToken().startMark);
    return this.parseBlockMappingKey();
  };

  readonly parseBlockMappingKey: State = () => {
    const scanner = this.p.scanner;
    if (scanner.checkToken("?")) {
      const token = scanner.getToken();
      if (!scanner.checkToken("?", ":", "<block end>")) {
        this.p.states.push(this.parseBlockMappingValue);
        return this.p.parseBlockNodeOrIndentlessSequence();
      }
      this.p.state = this.parseBlockMappingValue;
      return processEmptyScalar(token.endMark);
    }
    return this.parseBlockEnd("while parsing a block mapping", "MappingEnd");
  };

  readonly parseBlockMappingValue: State = () => {
    const scanner = this.p.scanner;
    if (scanner.checkToken(":")) {
      const token = scanner.getToken();
      if (!scanner.checkToken("?", ":", "<block end>")) {
        this.p.states.push(this.parseBlockMappingKey);
        return this.p.parseBlockNodeOrIndentlessSequence();
      }
      this.p.state = this.parseBlockMappingKey;
      return processEmptyScalar(token.endMark);
    }
    this.p.state = this.parseBlockMappingKey;
    return processEmptyScalar(scanner.peekToken().startMark);
  };

  // flow_sequence ::= FLOW-SEQUENCE-START (flow_sequence_entry FLOW-ENTRY)* flow_sequence_entry?
  //                   FLOW-SEQUENCE-END
  // flow_sequence_entry ::= flow_node | KEY flow_node? (VALUE flow_node?)?

  readonly parseFlowSequenceFirstEntry: State = () => {
    this.p.marks.push(this.p.scanner.getToken().startMark);
    return this.parseFlowSequenceEntryOf(true);
  };

  readonly parseFlowSequenceEntry: State = () => this.parseFlowSequenceEntryOf(false);

  parseFlowSequenceEntryOf(first: boolean): YamlEvent {
    const scanner = this.p.scanner;
    if (!scanner.checkToken("]")) {
      if (!first) {
        if (scanner.checkToken(",")) {
          scanner.getToken();
        } else {
          const token = scanner.peekToken();
          throw markedError(
            "while parsing a flow sequence",
            this.lastMark(),
            `expected ',' or ']', but got ${pyReprStr(token.id)}`,
            token.startMark,
          );
        }
      }
      if (scanner.checkToken("?")) {
        const token = scanner.peekToken();
        this.p.state = this.parseFlowSequenceEntryMappingKey;
        return {
          kind: "MappingStart",
          anchor: null,
          tag: null,
          implicit: true,
          flowStyle: true,
          ...marksOf(token),
        };
      }
      if (!scanner.checkToken("]")) {
        this.p.states.push(this.parseFlowSequenceEntry);
        return this.p.parseFlowNode();
      }
    }
    const token = scanner.getToken();
    this.p.state = this.p.popState();
    this.p.marks.pop();
    return { kind: "SequenceEnd", ...marksOf(token) };
  }

  readonly parseFlowSequenceEntryMappingKey: State = () => {
    const token = this.p.scanner.getToken();
    if (!this.p.scanner.checkToken(":", ",", "]")) {
      this.p.states.push(this.parseFlowSequenceEntryMappingValue);
      return this.p.parseFlowNode();
    }
    this.p.state = this.parseFlowSequenceEntryMappingValue;
    return processEmptyScalar(token.endMark);
  };

  readonly parseFlowSequenceEntryMappingValue: State = () => {
    const scanner = this.p.scanner;
    if (scanner.checkToken(":")) {
      const token = scanner.getToken();
      if (!scanner.checkToken(",", "]")) {
        this.p.states.push(this.parseFlowSequenceEntryMappingEnd);
        return this.p.parseFlowNode();
      }
      this.p.state = this.parseFlowSequenceEntryMappingEnd;
      return processEmptyScalar(token.endMark);
    }
    this.p.state = this.parseFlowSequenceEntryMappingEnd;
    return processEmptyScalar(scanner.peekToken().startMark);
  };

  readonly parseFlowSequenceEntryMappingEnd: State = () => {
    this.p.state = this.parseFlowSequenceEntry;
    const mark = this.p.scanner.peekToken().startMark;
    return { kind: "MappingEnd", startMark: mark, endMark: mark };
  };

  // flow_mapping ::= FLOW-MAPPING-START (flow_mapping_entry FLOW-ENTRY)* flow_mapping_entry?
  //                  FLOW-MAPPING-END
  // flow_mapping_entry ::= flow_node | KEY flow_node? (VALUE flow_node?)?

  readonly parseFlowMappingFirstKey: State = () => {
    this.p.marks.push(this.p.scanner.getToken().startMark);
    return this.parseFlowMappingKeyOf(true);
  };

  readonly parseFlowMappingKey: State = () => this.parseFlowMappingKeyOf(false);

  parseFlowMappingKeyOf(first: boolean): YamlEvent {
    const scanner = this.p.scanner;
    if (!scanner.checkToken("}")) {
      if (!first) {
        if (scanner.checkToken(",")) {
          scanner.getToken();
        } else {
          const token = scanner.peekToken();
          throw markedError(
            "while parsing a flow mapping",
            this.lastMark(),
            `expected ',' or '}', but got ${pyReprStr(token.id)}`,
            token.startMark,
          );
        }
      }
      if (scanner.checkToken("?")) {
        const token = scanner.getToken();
        if (!scanner.checkToken(":", ",", "}")) {
          this.p.states.push(this.parseFlowMappingValue);
          return this.p.parseFlowNode();
        }
        this.p.state = this.parseFlowMappingValue;
        return processEmptyScalar(token.endMark);
      }
      if (!scanner.checkToken("}")) {
        this.p.states.push(this.parseFlowMappingEmptyValue);
        return this.p.parseFlowNode();
      }
    }
    const token = scanner.getToken();
    this.p.state = this.p.popState();
    this.p.marks.pop();
    return { kind: "MappingEnd", ...marksOf(token) };
  }

  readonly parseFlowMappingValue: State = () => {
    const scanner = this.p.scanner;
    if (scanner.checkToken(":")) {
      const token = scanner.getToken();
      if (!scanner.checkToken(",", "}")) {
        this.p.states.push(this.parseFlowMappingKey);
        return this.p.parseFlowNode();
      }
      this.p.state = this.parseFlowMappingKey;
      return processEmptyScalar(token.endMark);
    }
    this.p.state = this.parseFlowMappingKey;
    return processEmptyScalar(scanner.peekToken().startMark);
  };

  readonly parseFlowMappingEmptyValue: State = () => {
    this.p.state = this.parseFlowMappingKey;
    return processEmptyScalar(this.p.scanner.peekToken().startMark);
  };
}
