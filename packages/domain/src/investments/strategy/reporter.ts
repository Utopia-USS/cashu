/**
 * The issue collector of one strategy.yaml parse (the `_add` / `_report` / `_section` / `_check_keys`
 * helpers of `strategy/loader.py`): turns param issues and messages into located `StrategyIssue`s.
 */

import { didYouMean } from "../rules/hints.js";
import { ParamErrors, type ParamIssue, ParamReader } from "../rules/params.js";
import { type IssueSeverity, isError, type StrategyIssue, strategyIssue } from "./issues.js";
import * as tree from "./yamlTree.js";

export class Reporter {
  readonly issues: StrategyIssue[] = [];
  /** The document's code points (marks index code points). */
  private readonly source: readonly string[];

  constructor(source: string) {
    this.source = Array.from(source);
  }

  get errorCount(): number {
    return this.issues.filter(isError).length;
  }

  push(issue: StrategyIssue): void {
    this.issues.push(issue);
  }

  error(path: string, node: tree.YamlNode, message: string): void {
    this.add("error", path, node, message);
  }

  warning(path: string, node: tree.YamlNode, message: string): void {
    this.add("warning", path, node, message);
  }

  /** `_add`: located at the node's start, or at `offset` inside a verbatim single-line scalar. */
  add(
    severity: IssueSeverity,
    path: string,
    node: tree.YamlNode,
    message: string,
    offset: number | null = null,
  ): void {
    const [line, start] = tree.position(node);
    let column = start;
    if (offset !== null) column = tree.exactColumn(this.source, node, offset) ?? column;
    this.issues.push(strategyIssue(severity, path, message, line, column));
  }

  /** `_report`: param issues keyed relative to `base` as located strategy issues. */
  report(issues: readonly ParamIssue[], base: tree.YamlNode, basePath: string): void {
    for (const issue of issues) {
      const node = tree.locate(base, issue.key, !issue.isError) ?? base;
      this.add(
        issue.isError ? "error" : "warning",
        joinPath(basePath, issue.key),
        node,
        issue.message,
        issue.offset,
      );
    }
  }

  /**
   * `_section`: reads the mapping under `key` with a ParamReader (unknown keys warned, issues
   * located). null when the key is absent or null, not a mapping (an error), or any error was recorded.
   */
  section<T>(
    parent: tree.MappingNode,
    key: string,
    read: (reader: ParamReader) => T,
    parentPath = "",
  ): T | null {
    const node = tree.get(parent, key);
    const path = joinPath(parentPath, key);
    if (tree.isAbsent(node)) return null;
    if (node.kind !== "mapping") {
      this.error(path, node, `${key} must be a mapping`);
      return null;
    }
    const errors = new ParamErrors();
    const reader = new ParamReader(tree.plainMap(node), errors);
    const value = read(reader);
    reader.finish();
    this.report(errors.issues, node, path);
    return errors.hasErrors ? null : value;
  }

  /** `_check_keys`: a warning for every key of `node` outside `known`. */
  checkKeys(node: tree.MappingNode, path: string, known: readonly string[]): void {
    for (const entry of tree.entries(node)) {
      if (!known.includes(entry.key)) {
        this.warning(
          joinPath(path, entry.key),
          entry.keyNode,
          `Unknown key "${entry.key}"${didYouMean(entry.key, known)}; it is ignored`,
        );
      }
    }
  }
}

/** `_join`: `a.b`, `a[1]`, or either side alone when the other is empty. */
function joinPath(base: string, key: string): string {
  if (!key) return base;
  if (!base) return key;
  return key.startsWith("[") ? `${base}${key}` : `${base}.${key}`;
}
