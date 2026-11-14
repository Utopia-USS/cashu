// Pure models of the Strategie tab (ab24ab6 v2/Strategies.tsx) and the strategy status card (v2/StrategySettings
// .tsx with Header.tsx strategyTag / StrategyPopover / ProposalNotice): every label, tone and formatted line the
// Views render, from the old JSON shapes (ui-logic types). Behaviour verbatim from the old components.
import { S as H } from "@cashu/i18n/investments/Header.strings";
import { S } from "@cashu/i18n/investments/v2/Strategies.strings";
import { describeIssue, proposalSummary } from "@cashu/ui-logic/core/messages";
import { dmy, money0, nBuckets, nRules } from "@cashu/ui-logic/investments/labels";
import type { StrategyDoc, StrategyIssue, StrategyStatus } from "@cashu/ui-logic/investments/types";
import { ruleKindLabel } from "@cashu/ui-logic/investments/v2/logic";
import {
  issuesByLine,
  type Selection,
  treeRows,
} from "@cashu/ui-logic/investments/v2/strategiesLogic";

type TagTone = "positive" | "negative" | "warning" | "info" | "neutral";
export interface TagModel {
  key: string;
  text: string;
  tone: TagTone;
  title?: string;
}

type Brief = { state: string; errors: number; warnings: number; inactive_rules: number } | null;

/** Header.tsx strategyTag: the strategy's validation in one tag. */
export function strategyTag(st: Brief): TagModel {
  if (!st || st.state === "missing") return { key: "st", text: H.none, tone: "warning" };
  // "partial": every error sits in an inactive rule (skipped), the rest of the strategy works.
  if (st.state === "invalid")
    return { key: "st", text: H.nErrors(st.errors || 1), tone: "negative" };
  const w = st.warnings + st.inactive_rules;
  return w
    ? { key: "st", text: H.nWarnings(w), tone: "warning" }
    : { key: "st", text: "OK", tone: "positive" };
}

const docTitle = (d: StrategyDoc) => d.title ?? (d.main ? S.mainTitle : d.id);

/** Strategies.tsx DocTags. */
function docTags(doc: StrategyDoc): TagModel[] {
  if (doc.main)
    return [
      strategyTag(doc.brief ?? null),
      ...(doc.files.length > 0
        ? [{ key: "ex", text: S.executed, tone: "neutral" as const, title: S.executedTitle }]
        : []),
    ];
  return [
    ...(doc.status ? [{ key: "status", text: doc.status, tone: "info" as const }] : []),
    { key: "doc", text: S.document, tone: "neutral", title: S.documentTitle },
  ];
}

type TreeFile =
  | { kind: "dir"; key: string; name: string; depth: number }
  | {
      kind: "file";
      key: string;
      name: string;
      depth: number;
      path: string;
      ext: "md" | "yaml" | "text";
      extText: string;
      on: boolean;
    };

export interface TreeGroup {
  key: string;
  id: string;
  title: string;
  tags: TagModel[];
  description: string | null;
  on: boolean;
  /** The doc button's selection (its main file, else its first file). */
  select: Selection;
  /** null = the doc has no files (`brak plików`). */
  files: TreeFile[] | null;
}

/** Strategies.tsx Tree. */
export function treeModel(list: readonly StrategyDoc[], sel: Selection | null): TreeGroup[] {
  return list.map((d) => ({
    key: d.id,
    id: d.id,
    title: docTitle(d),
    tags: docTags(d),
    description: d.description,
    on: sel?.id === d.id,
    select: { id: d.id, path: d.main_file ?? d.files[0]?.path ?? null },
    files:
      d.files.length === 0
        ? null
        : treeRows(d).map((r) =>
            r.kind === "dir"
              ? { kind: "dir" as const, key: r.key, name: r.name, depth: r.depth }
              : {
                  kind: "file" as const,
                  key: r.key,
                  name: r.name,
                  depth: r.depth,
                  path: r.path,
                  ext: r.fileKind,
                  extText: r.fileKind === "md" ? "MD" : r.fileKind === "yaml" ? "YML" : "TXT",
                  on: sel?.id === d.id && sel.path === r.path,
                },
          ),
  }));
}

export interface SourceLine {
  key: number;
  n: number;
  text: string;
  tone: "err" | "warn" | null;
  title: string | undefined;
  issue: string | null;
}

/** Strategies.tsx Source: numbered lines, an issue line under the lines that carry one. */
export function sourceLines(text: string, issues?: Map<number, StrategyIssue[]>): SourceLine[] {
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((l, k) => {
      const here = issues?.get(k + 1);
      const error = here?.some((i) => i.severity === "error");
      return {
        key: k,
        n: k + 1,
        text: l || " ",
        tone: here ? (error ? "err" : "warn") : null,
        title: here?.map((i) => describeIssue(i).text).join("\n"),
        issue: here ? here.map((i) => describeIssue(i).text).join("; ") : null,
      };
    });
}

export const yamlIssues = (st: StrategyStatus | null) => (st ? issuesByLine(st.issues) : undefined);

// ---- the status card (StrategyPopover) ------------------------------------------------------------------

export interface PendingProposal {
  gid: string;
  kind: string;
  summary: string | null;
  /** The summary code (= the kind) and its values: the localized line (core/messages.ts proposalSummary). */
  summary_code?: string | null;
  summary_params?: Record<string, unknown> | null;
}

export interface ProposalNoticeModel {
  head: string;
  what: string;
  gid: string;
}

/** Header.tsx ProposalNotice. */
export function proposalNotice(proposals: readonly PendingProposal[]): ProposalNoticeModel | null {
  const first = proposals[0];
  if (!first) return null;
  const what =
    proposalSummary(first) ||
    (first.kind === "strategy"
      ? H.propStrategy
      : first.kind === "custom_rule" || first.kind === "rule"
        ? H.propRule
        : first.kind === "import"
          ? H.propImport
          : first.kind);
  return {
    head: proposals.length > 1 ? H.proposals(proposals.length) : H.proposal,
    what,
    gid: first.gid,
  };
}

interface IssueItem {
  key: string;
  sev: "action" | "review" | "resolved";
  /** Bold lead (`Błąd:` / `Ostrzeżenie:`), null for an inactive rule or the currency note. */
  lead: string | null;
  text: string;
  code: string | null;
  line: string;
  title?: string;
}

interface VersionRow {
  key: number;
  version: string;
  saved: string;
  state: string;
}

/** Header.tsx StrategyPopover (not missing): heading, tags, facts, the issue list and the version table. */
export function popoverModel(st: StrategyStatus) {
  const f = st.facts;
  const current = st.versions.find((v) => v.version === st.version) ?? st.versions[0];
  // Errors of inactive rules are listed once, under the inactive rule (partial strategy).
  const inRule = (path: string) => /^rules\[\d+\]/.test(path);
  const errors = st.issues.filter(
    (i) => i.severity === "error" && !(st.state === "partial" && inRule(i.path)),
  );
  const warnings = st.issues.filter((i) => i.severity !== "error");
  const facts = f
    ? [
        nBuckets(f.buckets.length),
        nRules(f.rules.length),
        f.contributions
          ? H.contributions(
              money0(f.contributions.monthly_amount, f.base_currency),
              f.contributions.day_of_month,
            )
          : null,
        f.horizon_years ? H.horizon(f.horizon_years) : null,
        H.currency(f.base_currency),
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const line = (n: number | null) => (n ? H.line(n) : "");
  const tags: TagModel[] = [
    errors.length || st.state === "invalid"
      ? { key: "err", text: H.nErrors(errors.length || 1), tone: "negative" }
      : { key: "ok", text: H.yamlValid, tone: "positive" },
    ...(st.state === "partial" && st.inactive_rules.length > 0
      ? [{ key: "in", text: H.nInactive(st.inactive_rules.length), tone: "warning" as const }]
      : []),
  ];
  const items: IssueItem[] = [
    ...errors.map((i, k) => ({
      key: `e${k}`,
      sev: "action" as const,
      lead: H.error,
      text: describeIssue(i).text,
      code: i.path,
      line: line(i.line),
      title: i.message,
    })),
    ...warnings.map((i, k) => ({
      key: `w${k}`,
      sev: "review" as const,
      lead: H.warning,
      text: describeIssue(i).text,
      code: i.path || null,
      line: line(i.line),
      title: i.message,
    })),
    // The rule's position and kind (and its YAML line), never its strategy id (FE-A A6).
    ...st.inactive_rules.map((r) => ({
      key: `r${r.index}`,
      sev: "resolved" as const,
      lead: null,
      text: H.ruleInactive(
        r.index + 1,
        ruleKindLabel(r.kind),
        r.issues.map((i) => describeIssue(i).text).join("; "),
      ),
      code: null,
      line: line(r.line),
    })),
    ...(st.base_currency_note
      ? [
          {
            key: "cur",
            sev: "review" as const,
            lead: null,
            text: H.currencyDiffers,
            code: null,
            line: "",
          },
        ]
      : []),
  ];
  const versions: VersionRow[] = st.versions.map((v) => ({
    key: v.version,
    version: `v${v.version}`,
    saved: dmy(v.created_at),
    state:
      v.state === "valid"
        ? H.stateValid
        : v.state === "partial"
          ? H.statePartial(v.issues)
          : v.state === "invalid"
            ? H.stateInvalid
            : v.state,
  }));
  return {
    heading: `${H.strategy}${st.version != null ? ` · v${st.version}` : H.noVersion}`,
    tags,
    approved: current?.created_at ? H.approved(dmy(current.created_at)) : null,
    facts,
    readError: st.read_error ? `${H.readError} ${st.read_error}` : null,
    showList: st.issues.length > 0 || st.inactive_rules.length > 0 || !!st.base_currency_note,
    items,
    files: st.files,
    historyLabel: st.versions.length > 0 ? H.history(st.versions.length) : null,
    versions,
  };
}
