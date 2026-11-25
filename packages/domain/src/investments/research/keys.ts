/**
 * Identity of research signals (`research/keys.py`).
 *
 * A research signal has `rule_id = kind = "research:<note kind>"` and `dedup_key =
 * "research:<ISO week>|i:<instrument id>"`, `"research:<ISO week>|s:<segment key>"` (market segment,
 * P5) or `"research:<ISO week>|t:<theme key>"` (old theme notes): one signal per instrument, segment
 * or theme and week. Strategy rule ids cannot contain `:`, so the prefix never clashes.
 */

export const RESEARCH_PREFIX = "research:";

/** True for the rule id / dedup key / kind of a research signal. */
export function isResearchKey(value: string | null | undefined): boolean {
  return !!value && value.startsWith(RESEARCH_PREFIX);
}

export function researchRuleId(kind: string): string {
  return `${RESEARCH_PREFIX}${kind}`;
}

export interface ResearchScope {
  readonly instrumentId?: string | null;
  readonly segment?: string | null;
  readonly theme?: string | null;
}

/**
 * `research:2026-W40|i:12`, `research:2026-W40|s:gold` or `research:2026-W40|t:semiconductors`
 * (theme = its key); the instrument wins, then the segment.
 */
export function researchDedupKey(week: string, scope: ResearchScope = {}): string {
  let part: string;
  if (scope.instrumentId !== undefined && scope.instrumentId !== null) {
    part = `i:${scope.instrumentId}`;
  } else if (scope.segment !== undefined && scope.segment !== null) {
    part = `s:${scope.segment}`;
  } else {
    part = `t:${scope.theme === undefined || scope.theme === null ? "None" : scope.theme}`;
  }
  return `${RESEARCH_PREFIX}${week}|${part}`;
}
