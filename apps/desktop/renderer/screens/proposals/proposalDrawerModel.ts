// The proposal drawer's texts (ab24ab6 core/ProposalDrawer.tsx): kind tag, summary, submitted / status line,
// notices, the diff blocks, the backtest line and the import facts, from the native proposal detail.
import { S } from "@cashu/i18n/core/ProposalDrawer.strings";
import { proposalError, proposalSummary } from "@cashu/ui-logic/core/messages";
import { dm, dmy } from "@cashu/ui-logic/investments/labels";
import { P } from "./ProposalDrawer.strings.js";
import type { ProposalDrawerState } from "./useProposalDrawer.js";

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface DiffLine {
  key: number;
  text: string;
  tone: "add" | "del" | null;
}
export interface DiffBlockModel {
  title: string;
  lines: DiffLine[];
}
const diffBlock = (title: string, text: string): DiffBlockModel => ({
  title,
  lines: text.split("\n").map((l, k) => ({
    key: k,
    text: l || " ",
    tone:
      l.startsWith("+") && !l.startsWith("+++")
        ? "add"
        : l.startsWith("-") && !l.startsWith("---")
          ? "del"
          : null,
  })),
});

export function proposalDrawerModel(state: ProposalDrawerState) {
  const data = state.detail;
  const display = data?.display;
  const budgetImport = data?.kind === "budget_import";
  const isImport = data?.kind === "import" || budgetImport;
  // why applying failed (stable error_code -> label)
  const failure = proposalError(data?.result);
  const kindLabel = !data
    ? ""
    : budgetImport
      ? S.kindBudgetImport
      : isImport
        ? S.kindImport
        : data.kind === "strategy"
          ? S.kindStrategy
          : S.kindRule;
  const payload = data?.payload ?? {};
  const fromConnector =
    display?.fromConnector ?? (payload.source === "connector" || data?.source === "connector");
  const connectorName = display?.connectorName ?? str(payload.connector_name);
  const since = display?.since ?? str(payload.since);
  const bt = display?.backtest ?? null;
  const pv = display?.preview ?? null;
  const unsupported = !!display?.converterUnsupported;
  const statusText: Record<string, string> = {
    approved: S.approved,
    rejected: S.rejected,
    failed: S.failed,
  };
  const btRange = bt
    ? `${str(bt.from) ? dm(str(bt.from)) : ""}${str(bt.to) ? ` - ${dm(str(bt.to))}` : ""}`
    : "";
  const instruments = Array.isArray(bt?.instruments)
    ? (bt.instruments as unknown[]).map(String)
    : [];
  // A native-only outcome of the approve / reject (busy, base changed, recovery...) or the failure.
  const error = state.message
    ? failure && state.message === "failed"
      ? failure
      : { text: P[state.message], detail: null }
    : null;
  return {
    title: S.title,
    tag: data ? kindLabel : null,
    pending: data?.status === "pending",
    reject: S.reject,
    approve: isImport ? S.approveImport : S.approveAs(data?.nextStrategyVersion ?? 1),
    approveDisabled: state.busy || unsupported,
    busy: state.busy,
    onApprove: state.onApproved,
    onReject: state.onRejected,
    error,
    failedNotice: !error && data?.status === "failed" && failure ? failure : null,
    notFound: data ? null : P.notFound,
    // ProposalDrawer.tsx: the localized line from the summary code and its values, else the English summary.
    summary: data
      ? proposalSummary({
          kind: data.kind,
          summary: data.summary,
          summary_code: data.summaryCode,
          summary_params: data.summaryParams,
        }) || S.changeProposal
      : "",
    meta: data
      ? `${data.createdAt ? S.submitted(dmy(data.createdAt)) : ""}${data.status !== "pending" ? ` · ${statusText[data.status] ?? data.status}` : ""}`
      : "",
    detailError: display?.detailError && !unsupported ? P.detailsUnavailable : null,
    unsupported: unsupported ? S.unsupported : null,
    baseChanged: display?.baseChanged ? S.baseChanged : null,
    reason: data?.reason ? { lead: S.agentReason, text: data.reason } : null,
    diffs: [
      ...(display?.yamlDiff ? [diffBlock(S.yamlChange, display.yamlDiff)] : []),
      ...(display?.mdDiff ? [diffBlock(S.mdChange, display.mdDiff)] : []),
      ...(!display?.yamlDiff && display?.ruleYaml ? [diffBlock(S.newRule, display.ruleYaml)] : []),
    ],
    backtest: bt
      ? num(bt.evaluated)
        ? `${S.backtest(btRange, num(bt.points_fired), num(bt.evaluated), num(bt.episodes))}${str(bt.last_fired) ? S.lastFired(dm(str(bt.last_fired))) : ""}${instruments.length ? ` · ${instruments.join(", ")}` : ""}.`
        : S.noHistory
      : null,
    importFacts: isImport
      ? {
          connector: fromConnector
            ? {
                label: S.source,
                name: connectorName ?? "-",
                tag: S.connector,
                since: since ? S.since(dm(since)) : null,
              }
            : null,
          file:
            !fromConnector || display?.fileName
              ? { label: S.file, value: display?.fileName ?? "-" }
              : null,
          account: {
            label: budgetImport ? S.account : S.brokerageAccount,
            value: display?.accountLabel ?? display?.account ?? "-",
          },
          preview: pv
            ? {
                label: S.preview,
                value: budgetImport
                  ? `${S.newTxns(num(pv.new))} · ${S.duplicates(num(pv.duplicates))}${num(pv.warnings) ? ` · ${S.warnings(num(pv.warnings))}` : ""}`
                  : `${S.newRows(num(pv.new))} · ${S.duplicates(num(pv.duplicates))}${num(pv.reconciliation_mismatches) ? ` · ${S.mismatches(num(pv.reconciliation_mismatches))}` : ""}${num(pv.errors) ? ` · ${S.errors(num(pv.errors))}` : ""}`,
              }
            : null,
        }
      : null,
    foot: S.rejectChangesNothing,
  };
}
export type ProposalDrawerModel = ReturnType<typeof proposalDrawerModel>;
