/** Current document data is host-owned; recorded history never substitutes for current files. */
import { toCurrency, views } from "@cashu/domain/investments";
import type { StrategyStateName } from "@cashu/domain/investments/strategy";
import { z } from "zod";
import { enabledModuleIds, profileOf } from "../../core/queries.js";
import { type ChangeSource, defineQuery, type Read } from "../../query.js";
import type { UiAction } from "../../ui-actions.js";
export const strategyScreenArgsSchema = z.strictObject({
  lang: z.enum(["pl", "en"]),
  privacy: z.boolean(),
  selection: z
    .strictObject({ document: z.string().min(1).max(64), path: z.string().min(1).max(1024) })
    .nullable(),
});

import { SUMMARY_PARAMS } from "../../core/proposal-commands.js";
import { type CurrentStrategySource, combinedChanges } from "../desktop/sources.js";
import { jsonList } from "../queries/shared.js";
import type { StrategyDocSummary } from "../services/strategy-docs.js";
import { nativeStrategyStatus } from "../views/strategyStatus.js";

/** A proposal payload's `summary_params` (an object, else empty). */
function jsonParams(payload: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(payload);
  const out =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)[SUMMARY_PARAMS]
      : undefined;
  return out && typeof out === "object" && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : {};
}

export type StrategySelection = { readonly document: string; readonly path: string };
export type SelectedStrategyFile =
  | {
      readonly status: "ready";
      readonly selection: StrategySelection;
      readonly text: string;
      readonly absolutePath?: string | null;
    }
  | {
      readonly status: "no_file" | "too_large" | "unreadable";
      readonly selection: StrategySelection;
    };
export interface StrategyDocumentsImage {
  readonly vault: string;
  readonly generation: string;
  readonly revision: string;
  readonly documents: readonly StrategyDocSummary[];
  readonly selected: SelectedStrategyFile | null;
  readonly loaded?: readonly {
    readonly requested: StrategySelection | null;
    readonly file: SelectedStrategyFile | null;
  }[];
  readonly paths: { readonly yaml: string; readonly md: string; readonly folder: string } | null;
  readonly yamlExists: boolean;
  readonly mdExists: boolean;
  readonly canReload: boolean;
  readonly canInit: boolean;
}
export interface StrategyDocumentsSource {
  readonly changes: ChangeSource;
  current(read: Read): StrategyDocumentsImage | null;
}
export const strategyRefresh: UiAction<Record<string, never>, { readonly revision: string }> = {
  id: "investments.strategies.refresh",
};
export type StrategyReadFileResult = {
  readonly status: "ready" | "no_file" | "too_large" | "unreadable";
  readonly revision: string;
};
export type StrategyReloadResult =
  | { readonly status: "recorded"; readonly revision: string; readonly version: number }
  | { readonly status: "unchanged"; readonly revision: string; readonly version: number | null }
  | { readonly status: "missing" | "read_failed"; readonly revision: string }
  | { readonly status: "not_recorded"; readonly revision: string; readonly reason: string };
export type StrategyInitResult =
  | { readonly status: "created_and_recorded"; readonly revision: string; readonly version: number }
  | {
      readonly status: "files_created_not_recorded" | "partial_files";
      readonly revision: string;
      readonly written: readonly ("strategy.yaml" | "strategy.md")[];
      readonly reason: string;
    }
  | {
      readonly status: "recovery_required";
      readonly reason: string;
      readonly written?: readonly ("strategy.yaml" | "strategy.md")[];
    };
export const strategyReadFile: UiAction<
  StrategySelection & { readonly revision: string },
  StrategyReadFileResult
> = { id: "investments.strategies.readFile" };
export const strategyReload: UiAction<{ readonly revision: string }, StrategyReloadResult> = {
  id: "investments.strategies.reload",
};
export const strategyInit: UiAction<{ readonly revision: string }, StrategyInitResult> = {
  id: "investments.strategies.init",
};
const silent: ChangeSource = { subscribe: () => () => {} };
export function strategiesQueries(
  options: {
    readonly strategy?: CurrentStrategySource;
    readonly documents?: StrategyDocumentsSource;
  } = {},
) {
  return {
    screen: defineQuery({
      id: "investments.strategies.screen",
      changes: combinedChanges(
        options.strategy?.changes ?? silent,
        options.documents?.changes ?? silent,
      ),
      run(
        read,
        args: {
          readonly lang: "pl" | "en";
          readonly privacy: boolean;
          readonly selection: StrategySelection | null;
        },
      ) {
        if (args.privacy)
          return { status: "unavailable" as const, reason: "privacy", proposals: [], versions: [] };
        if (!enabledModuleIds(read).has("investments"))
          return {
            status: "unavailable" as const,
            reason: "module_disabled",
            proposals: [],
            versions: [],
          };
        // The summary code (= the kind) and its stored values for the localized line (Python `proposal_dict`).
        const proposals = read<{ gid: string; summary: string; kind: string; payload: string }>(
          "SELECT gid, summary, kind, payload FROM proposals WHERE status = 'pending' AND kind IN ('strategy', 'custom_rule', 'import') ORDER BY id",
        ).map(({ payload, ...row }) => ({
          ...row,
          summaryCode: row.kind,
          summaryParams: jsonParams(payload),
        }));
        // Metadata only: the history list never loads every historical YAML/Markdown document.
        const history = read<{
          version: number;
          state: Exclude<StrategyStateName, "missing">;
          createdAt: string;
          sha256: string;
          issues: string;
        }>(
          "SELECT version, state, created_at AS createdAt, sha256, issues FROM inv_strategy_versions ORDER BY version DESC",
        ).map((version) => ({ ...version, issues: jsonList(version.issues) }));
        const versions = history.map((version) => ({
          version: version.version,
          state: version.state,
          createdAt: version.createdAt,
          issues: version.issues.length,
        }));
        const current = options.strategy?.current(read);
        const documents = options.documents?.current(read);
        if (
          current?.status !== "current" ||
          !documents ||
          current.revision !== documents.revision ||
          current.vault !== documents.vault ||
          current.generation !== documents.generation
        )
          return {
            status: "unavailable" as const,
            reason: "capability_unavailable",
            proposals,
            versions,
          };
        const selected = documents.loaded
          ? (documents.loaded.find(
              (entry) => JSON.stringify(entry.requested) === JSON.stringify(args.selection),
            )?.file ?? null)
          : args.selection === null ||
              (documents.selected?.selection.document === args.selection.document &&
                documents.selected.selection.path === args.selection.path)
            ? documents.selected
            : null;
        const status = views.strategyStatusView({
          status: nativeStrategyStatus(current.state),
          versions: history,
          files: {
            yaml: documents.paths?.yaml ?? "",
            md: documents.paths?.md ?? "",
            yamlExists: documents.yamlExists,
            mdExists: documents.mdExists,
          },
          profileBase: toCurrency(profileOf(read)?.baseCurrency ?? "PLN"),
          lang: args.lang,
        });
        return {
          status: "current" as const,
          revision: documents.revision,
          documents: documents.documents,
          paths: documents.paths,
          selected,
          strategy: status,
          currentIssues: current.state.issues,
          inactiveRules: current.state.inactiveRules,
          proposals,
          versions,
          canReload: documents.canReload,
          canInit: documents.canInit,
        };
      },
    }),
  };
}
export type StrategiesSnapshot = ReturnType<ReturnType<typeof strategiesQueries>["screen"]["run"]>;
// Host registers this existing deduplicating primitive; it does not create a second save algorithm.
export { saveStrategyVersion } from "../commands/strategy.js";
export { ensureReloadProxy } from "./proxy.js";
