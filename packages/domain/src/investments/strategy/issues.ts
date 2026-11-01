/** Validation results of strategy.yaml / strategy.md (`strategy/issues.py`). */

import { classify } from "./codes.js";
import type { StrategyConfig } from "./config.js";

/** Errors reject the strategy; warnings are only reported. */
export const IssueSeverity = Object.freeze({ ERROR: "error", WARNING: "warning" } as const);
export type IssueSeverity = (typeof IssueSeverity)[keyof typeof IssueSeverity];

/** One problem found by the strategy loader (`StrategyIssue`). */
export interface StrategyIssue {
  readonly severity: IssueSeverity;
  /**
   * YAML path of the offending node (`rules[2].params.threshold`, `allocation.targets.bonds`); empty
   * for the whole document, `strategy.md` for the prose file.
   */
  readonly path: string;
  /** English, one sentence, names the key and usually the bad value (and a "did you mean" hint). */
  readonly message: string;
  /** 1-based line in strategy.yaml, null when the issue has no YAML location. */
  readonly line: number | null;
  /** 1-based column in strategy.yaml, null when the issue has no YAML location. */
  readonly column: number | null;
  /** Stable machine-readable code (`strategy.<name>`, see `codes.ts`); `strategy.other` = no template. */
  readonly code: string;
  /** The variable parts of `message` by name (bucket, key, value, suggestion, ...). */
  readonly params: Readonly<Record<string, string>>;
}

/** `StrategyIssue(...)`: the code and params derived from the message unless given. */
export function strategyIssue(
  severity: IssueSeverity,
  path: string,
  message: string,
  line: number | null = null,
  column: number | null = null,
  coded?: { readonly code: string; readonly params?: Readonly<Record<string, string>> },
): StrategyIssue {
  const [code, params] = coded ? [coded.code, coded.params ?? {}] : classify(message);
  return Object.freeze({ severity, path, message, line, column, code, params });
}

export function isError(issue: StrategyIssue): boolean {
  return issue.severity === IssueSeverity.ERROR;
}

/** `str(issue)`: `error rules[0].kind (line 3, column 5): ...`. */
export function issueText(issue: StrategyIssue): string {
  const where = [issue.path, issue.line ? `(line ${issue.line}, column ${issue.column})` : ""]
    .filter((part) => part)
    .join(" ");
  return `${issue.severity}${where ? ` ${where}` : ""}: ${issue.message}`;
}

/** A rule entry left out of the strategy because of its own errors (`rules[index]`). */
export interface InactiveRule {
  readonly index: number;
  /** The entry's `id` when it is a plain string, else null. */
  readonly ruleId: string | null;
  readonly kind: string | null;
  /** 1-based line of the entry in strategy.yaml. */
  readonly line: number | null;
  /** The errors that made it inactive. */
  readonly issues: readonly StrategyIssue[];
}

/**
 * A `config` when there is no error, plus every issue (warnings may accompany a valid config).
 * `partial`: when every error belongs to a rule entry (`rules[i]...`), the config built from
 * everything else and the valid rules; `config` stays null and the left-out entries are listed in
 * `inactiveRules`.
 */
export interface StrategyLoadResult {
  readonly config: StrategyConfig | null;
  readonly issues: readonly StrategyIssue[];
  readonly partial: StrategyConfig | null;
  readonly inactiveRules: readonly InactiveRule[];
}

export function isValid(result: StrategyLoadResult): boolean {
  return result.config !== null;
}

export function errorsOf(result: StrategyLoadResult): StrategyIssue[] {
  return result.issues.filter(isError);
}

export function warningsOf(result: StrategyLoadResult): StrategyIssue[] {
  return result.issues.filter((issue) => !isError(issue));
}
