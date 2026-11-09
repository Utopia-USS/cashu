// The Strategie tab (ab24ab6 v2/Strategies.tsx InvestmentsStrategies): the file tree of the strategies, the
// selected file (Markdown preview or numbered source with the main strategy.yaml's issues) and, for the main
// strategy, the status card beside it. Reads the native strategies screen with the file selection; the old
// StrategyDoc / StrategyStatus shapes are rebuilt here, the old toasts follow every copy and write.
import { lang } from "@cashu/i18n";
import { S } from "@cashu/i18n/investments/v2/Strategies.strings";
import { strategiesQueries, strategyRefresh } from "@cashu/store/investments/strategies-screen";
import { useQuery, useUiAction } from "@cashu/store-react";
import { useToast, useUiEnv } from "@cashu/ui";
import { label } from "@cashu/ui-logic/core/messages";
import type { StrategyDoc, StrategyStatus } from "@cashu/ui-logic/investments/types";
import {
  absolutePath,
  MAIN_ID,
  pickSelection,
  type Selection,
} from "@cashu/ui-logic/investments/v2/strategiesLogic";
import { startTransition, useEffect, useEffectEvent, useState } from "react";
import { wire } from "../investments/home/legacyWire.js";
import { S as N } from "./Strategies.strings.js";
import { sourceLines, treeModel, yamlIssues } from "./strategiesModel.js";
import { copyText, useStrategyWrites } from "./useStrategySettings.js";

const queries = strategiesQueries();
const reasonText = (reason: string) => label(`error.${reason}`) ?? reason;

export interface StrategiesScreenOptions {
  /** Opens a pending proposal of the status card (the route's proposal drawer). */
  onProposalOpened?(gid: string): void;
}

export function useStrategiesScreen(o: StrategiesScreenOptions) {
  const toast = useToast();
  const { privacy } = useUiEnv();
  const [picked, setPicked] = useState<Selection | null>(null);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const selection = picked?.path ? { document: picked.id, path: picked.path } : null;
  const data = useQuery(queries.screen, { lang: lang(), privacy, selection });
  const writes = useStrategyWrites(data.status === "current" ? data.revision : null);
  // The old tab read the folder on every visit: re-scan the strategy files once when the tab opens.
  // `run` is a new function on every render, so the effect must not depend on it: that re-ran the
  // refresh after every render it caused (a host busy loop for as long as the tab stayed open).
  const refresh = useUiAction(strategyRefresh);
  const refreshOnOpen = useEffectEvent(() => {
    void refresh.run({}).catch(() => null);
  });
  useEffect(() => {
    refreshOnOpen();
  }, []);

  if (data.status !== "current")
    return {
      phase: "unavailable" as const,
      text: data.reason === "privacy" ? N.privacy : S.listFailed(reasonText(data.reason)),
    };

  const status = wire<StrategyStatus>(data.strategy);
  const list: StrategyDoc[] = data.documents.map((d) => ({
    id: d.id,
    main: d.main,
    executed: d.executed,
    title: d.title,
    status: d.status,
    description: d.description,
    main_file: d.mainFile,
    root: d.root,
    files: d.files.map((f) => ({ path: f.path, kind: f.kind ?? "text" })),
    ...(d.main
      ? {
          brief: {
            state: status.state,
            version: status.version,
            changed: status.changed,
            errors: status.errors,
            warnings: status.warnings,
            inactive_rules: status.inactive_rules.length,
          },
        }
      : {}),
  }));
  // Before the first pick the host's own selection is the current one.
  const hostSel =
    picked == null && data.selected
      ? { id: data.selected.selection.document, path: data.selected.selection.path }
      : null;
  const sel = pickSelection(list, picked ?? hostSel);
  const doc = list.find((d) => d.id === sel?.id) ?? null;
  const anyFiles = list.some((d) => d.files.length > 0);
  const withSide = doc?.id === MAIN_ID && doc.files.length > 0;
  const pick = (s: Selection) => startTransition(() => setPicked(s));

  const noStrategy = (main: boolean) => ({
    kind: "none" as const,
    title: main ? S.mainTitle : S.noneTitle,
    hint: main ? S.mainMissing : S.noneHint,
    fromTemplate: S.fromTemplate,
    copyCommand: S.copyCommand,
    onTemplate: () => {
      void writes
        .init()
        .then((failure) =>
          failure === null ? toast(S.created, 3000) : toast(S.createFailed(failure), 4000),
        );
    },
    onCopyCommand: () => {
      void copyText("/investments-setup", () => toast(S.commandCopied, 2000));
    },
  });

  const fileView = (d: StrategyDoc, path: string) => {
    const kind = d.files.find((f) => f.path === path)?.kind ?? "text";
    const mainYaml = d.main && path === "strategy.yaml";
    const issues = mainYaml ? yamlIssues(status) : undefined;
    const name = path.split("/").pop() ?? path;
    const file =
      data.selected &&
      data.selected.selection.document === d.id &&
      data.selected.selection.path === path
        ? data.selected
        : null;
    const text = file?.status === "ready" ? file.text : null;
    const body =
      file && file.status !== "ready"
        ? { kind: "error" as const, text: S.loadFailed(reasonText(file.status)) }
        : text == null
          ? { kind: "loading" as const }
          : text.trim() === ""
            ? { kind: "empty" as const, text: S.emptyFile }
            : kind === "md" && mode === "preview"
              ? { kind: "md" as const, text }
              : { kind: "source" as const, lines: sourceLines(text, issues) };
    const absolute = (file?.status === "ready" ? file.absolutePath : null) ?? absolutePath(d, path);
    return {
      kind: "file" as const,
      crumb: d.title ?? (d.main ? S.mainTitle : d.id),
      path,
      mode:
        kind === "md"
          ? {
              label: S.viewMode,
              items: [
                [S.preview, "preview"],
                [S.source, "source"],
              ] as [string, "preview" | "source"][],
              value: mode,
              onChange: (v: "preview" | "source") => setMode(v),
            }
          : null,
      copyPath: S.copyPath,
      onCopyPath: () => {
        void copyText(absolute, () => toast(S.pathCopied(name), 2000));
      },
      notExecuted: kind === "yaml" && !d.executed ? S.notExecuted : null,
      issuesNote:
        mainYaml && issues && issues.size > 0
          ? S.issuesHere(status.issues.filter((i) => i.line).length)
          : null,
      body,
    };
  };

  return {
    phase: "ready" as const,
    withSide,
    listLabel: S.listLabel,
    tree: treeModel(list, sel),
    noFiles: S.noFiles,
    pick,
    folderHint: S.folderHint,
    copyFolder: S.copyFolder,
    onCopyFolder: () => {
      void copyText(data.paths?.folder ?? "", () => toast(S.pathCopied("strategies"), 2000));
    },
    main:
      !anyFiles || !doc
        ? noStrategy(false)
        : doc.files.length === 0 || !sel?.path
          ? noStrategy(doc.main)
          : fileView(doc, sel.path),
    onProposalOpened: o.onProposalOpened,
  };
}
export type StrategiesScreenState = ReturnType<typeof useStrategiesScreen>;
