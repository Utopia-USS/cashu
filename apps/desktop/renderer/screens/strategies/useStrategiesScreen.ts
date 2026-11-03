import { lang } from "@cashu/i18n";
import {
  type StrategyInitResult,
  type StrategyReloadResult,
  type StrategySelection,
  strategiesQueries,
  strategyInit,
  strategyReadFile,
  strategyRefresh,
  strategyReload,
} from "@cashu/store/investments/strategies-screen";
import type { UiActionResult } from "@cashu/store/ui-actions";
import { useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { describeIssue } from "@cashu/ui-logic/core/messages";
import { treeRows } from "@cashu/ui-logic/investments/v2/strategiesLogic";
import { useEffect, useRef, useState } from "react";
import { S } from "./Strategies.strings.js";

const queries = strategiesQueries();
export function useStrategiesScreen(onProposalOpened?: (gid: string) => void) {
  const [selection, setSelection] = useState<StrategySelection | null>(null);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [history, setHistory] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { privacy } = useUiEnv();
  const data = useQuery(queries.screen, { lang: lang(), privacy, selection });
  const refresh = useUiAction(strategyRefresh);
  const read = useUiAction(strategyReadFile);
  const reload = useUiAction(strategyReload);
  const init = useUiAction(strategyInit);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const docs = data.status === "current" ? data.documents : [];
  const selectedFile = data.status === "current" ? data.selected : null;
  const doc =
    docs.find((d) => d.id === selectedFile?.selection.document) ??
    docs.find((d) => d.id === selection?.document) ??
    docs.find((d) => d.files.length > 0) ??
    docs[0] ??
    null;
  const path =
    selectedFile?.selection.path ??
    (doc?.files.some((f) => f.path === selection?.path)
      ? (selection?.path ?? null)
      : (doc?.mainFile ?? doc?.files[0]?.path ?? null));
  const current = doc && path ? { document: doc.id, path } : null;
  const busy = refresh.isPending || read.isPending || reload.isPending || init.isPending;
  const act = async (kind: "refresh" | "reload" | "init") => {
    if (pending.current || privacy) return;
    pending.current = true;
    setNotice(null);
    try {
      const revision = data.status === "current" ? data.revision : "";
      const result: UiActionResult<
        StrategyReloadResult | StrategyInitResult | { readonly revision: string }
      > =
        kind === "refresh"
          ? await refresh.run({})
          : kind === "reload"
            ? await reload.run({ revision })
            : await init.run({ revision });
      if (!mounted.current) return;
      if (result.status === "outcome_unknown") setNotice(S.unknown);
      else if (result.status !== "completed")
        setNotice(result.status === "not_started" ? S.actionUnavailable : S.refused);
      else if ("status" in result.value)
        setNotice(
          result.value.status === "recorded" || result.value.status === "created_and_recorded"
            ? S.recorded
            : result.value.status === "unchanged"
              ? S.unchanged
              : S.partial,
        );
    } catch {
      if (mounted.current) setNotice(S.unknown);
    } finally {
      pending.current = false;
    }
  };
  const pick = (picked: StrategySelection) => {
    if (!privacy) {
      setSelection(picked);
      setMode("preview");
    }
  };
  const lineIssues =
    data.status === "current"
      ? data.currentIssues.map((issue) => ({ ...issue, text: describeIssue(issue).text }))
      : [];
  const issues =
    data.status === "current"
      ? data.currentIssues
          .filter(
            (issue) =>
              !data.inactiveRules.some((rule) =>
                rule.issues.some(
                  (other) =>
                    other.code === issue.code &&
                    other.path === issue.path &&
                    other.line === issue.line,
                ),
              ),
          )
          .map((issue) => ({ ...issue, text: describeIssue(issue).text }))
      : [];
  const inactiveRules =
    data.status === "current"
      ? data.inactiveRules.map((rule) => ({
          ...rule,
          issues: rule.issues.map((issue) => ({ ...issue, text: describeIssue(issue).text })),
        }))
      : [];
  const tree = docs.flatMap((doc) => [
    {
      key: doc.id,
      kind: "doc" as const,
      depth: 0,
      document: doc.id,
      path: doc.mainFile ?? doc.files[0]?.path ?? null,
      title: doc.title ?? (doc.main ? S.main : doc.id),
      main: doc.main && doc.files.length > 0,
      status: doc.status,
      description: doc.description,
    },
    ...treeRows({
      ...doc,
      main_file: doc.mainFile,
      files: doc.files.map((file) => ({ ...file, kind: file.kind ?? "text" })),
    }).map((row) => ({
      key: `${doc.id}:${row.key}`,
      kind: row.kind,
      depth: row.depth + 1,
      document: doc.id,
      path: row.kind === "file" ? row.path : null,
      title: row.name + (row.kind === "dir" ? "/" : ""),
      main: false,
      status: null,
      description: null,
    })),
  ]);
  return {
    tree,
    lineIssues,
    inactiveRules,
    data,
    docs,
    doc,
    current,
    selection,
    pick,
    mode,
    setMode,
    history,
    setHistory,
    notice,
    privacy,
    busy,
    act,
    issues,
    onProposalOpened,
    copy: async (text: string) => {
      if (!privacy) {
        try {
          await navigator.clipboard.writeText(text);
          if (mounted.current) setNotice(S.copied);
        } catch {
          if (mounted.current) setNotice(S.copyFailed);
        }
      }
    },
  };
}
export type StrategiesScreenState = ReturnType<typeof useStrategiesScreen>;
