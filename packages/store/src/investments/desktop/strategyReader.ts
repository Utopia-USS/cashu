// The strategy as the phone reads it: the synced main version's text (the reader tile renders its
// markdown) and the rules the current strategy runs, with no market and no valuation. The rules come from
// the bound strategy source's parsed config (the same snapshot every screen query uses), so a version the
// parser rejects shows its text with no rules.
import type { RuleSpec } from "@cashu/domain/investments/rules";
import { enabledModuleIds } from "../../core/queries.js";
import { defineQuery } from "../../query.js";
import { latestStrategyVersion } from "../queries/strategy.js";
import type { CurrentStrategySource } from "./sources.js";

export interface StrategyReaderRule {
  readonly id: string;
  readonly kind: string;
  readonly severity: RuleSpec["severity"];
  /** The parsed params' top-level numbers and texts (`maxWeight`, `threshold`, a custom rule's
   * `message`); nested filters stay out, so the row is plain data. */
  readonly params: Readonly<Record<string, number | string>>;
}

export type StrategyReader =
  | { readonly status: "unavailable"; readonly reason: "module_disabled" }
  /** Nothing synced from the Mac yet. */
  | { readonly status: "none" }
  | {
      readonly status: "current";
      readonly version: {
        readonly gid: string;
        readonly version: number;
        /** View timestamp of the save (`YYYY-MM-DD HH:MM:SS.ffffff`, naive UTC). */
        readonly createdAt: string;
        readonly mdText: string | null;
      };
      /** The parsed strategy's rules in declaration order; empty when the strategy does not parse. */
      readonly rules: readonly StrategyReaderRule[];
    };

function plainParams(value: unknown): Readonly<Record<string, number | string>> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number | string] =>
        typeof entry[1] === "number" || typeof entry[1] === "string",
    ),
  );
}

export function strategyReaderQuery(sources: { readonly strategy?: CurrentStrategySource }) {
  return defineQuery({
    id: "investments.strategy.reader",
    ...(sources.strategy === undefined ? {} : { changes: sources.strategy.changes }),
    run(read): StrategyReader {
      if (!enabledModuleIds(read).has("investments"))
        return { status: "unavailable", reason: "module_disabled" };
      const version = latestStrategyVersion(read);
      if (version === undefined) return { status: "none" };
      const snapshot = sources.strategy?.current(read);
      const config = snapshot?.status === "current" ? snapshot.state.config : null;
      return {
        status: "current",
        version: {
          gid: version.gid,
          version: version.version,
          createdAt: version.createdAt,
          mdText: version.mdText,
        },
        rules: (config?.rules ?? []).map((rule) => ({
          id: rule.id,
          kind: rule.kind,
          severity: rule.severity,
          params: plainParams(rule.params),
        })),
      };
    },
  });
}
