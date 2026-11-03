import { S } from "@cashu/i18n/core/ProposalDrawer.strings";
import { DateText } from "@cashu/ui";
import { P } from "./ProposalDrawer.strings.js";
import type { ProposalDrawerState } from "./useProposalDrawer.js";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Review one canonical proposal; all execution and filesystem work stays in the host. */
export function ProposalDrawerView({
  state,
  onClose,
}: {
  state: ProposalDrawerState;
  onClose(): void;
}) {
  const detail = state.detail;
  const display = detail?.display;
  const preview = display?.preview;
  const backtest = display?.backtest;
  const unsupported = display?.converterUnsupported ?? false;
  const kind =
    detail &&
    {
      strategy: S.kindStrategy,
      custom_rule: S.kindRule,
      import: S.kindImport,
      budget_import: S.kindBudgetImport,
    }[detail.kind];
  const status =
    detail &&
    {
      pending: P.pending,
      approved: S.approved,
      rejected: S.rejected,
      failed: S.failed,
    }[detail.status];
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-xl font-semibold">{S.title}</h2>
        <button type="button" onClick={onClose} aria-label={P.close}>
          {P.close}
        </button>
      </div>
      {!detail ? (
        <p role="status" className="mt-6">
          {P.notFound}
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm text-fg-muted">
            {kind} · {status} · <DateText value={detail.createdAt.slice(0, 10)} />
          </p>
          <h3 className="mt-4 font-semibold">{detail.summary || P.hidden}</h3>
          {detail.reason && (
            <p className="mt-3">
              <strong>{S.agentReason}</strong> {detail.reason}
            </p>
          )}
          {state.message && (
            <p role="alert" className="mt-3 rounded-md border border-border p-3">
              {P[state.message]}
            </p>
          )}
          {detail.status === "failed" && (
            <p role="alert" className="mt-3">
              {S.failed} {state.failure}
            </p>
          )}
          {unsupported && (
            <p role="note" className="mt-3">
              {P.unsupported}
            </p>
          )}
          {display?.baseChanged && (
            <p role="alert" className="mt-3">
              {S.baseChanged}
            </p>
          )}
          {display?.detailError && (
            <p role="status" className="mt-3">
              {P.detailsUnavailable}
            </p>
          )}
          {(detail.kind === "strategy" || detail.kind === "custom_rule") && (
            <>
              {display?.diffAvailability !== "ready" && (
                <p className="mt-4 text-sm text-fg-muted">{P.unavailableDiff}</p>
              )}
              {display?.yamlDiff && <TextBlock title={S.yamlChange} value={display.yamlDiff} />}
              {display?.mdDiff && <TextBlock title={S.mdChange} value={display.mdDiff} />}
              {!display?.yamlDiff && display?.ruleYaml && (
                <TextBlock title={S.newRule} value={display.ruleYaml} />
              )}
              {backtest && (
                <p className="mt-4 text-sm">
                  {count(backtest.evaluated)
                    ? S.backtest(
                        `${text(backtest.from) ?? ""} - ${text(backtest.to) ?? ""}`,
                        count(backtest.points_fired),
                        count(backtest.evaluated),
                        count(backtest.episodes),
                      )
                    : S.noHistory}
                </p>
              )}
            </>
          )}
          {(detail.kind === "import" || detail.kind === "budget_import") && (
            <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
              <dt>{S.source}</dt>
              <dd>{display?.connectorName ?? detail.source}</dd>
              <dt>{S.file}</dt>
              <dd>{display?.fileName ?? "-"}</dd>
              <dt>{S.account}</dt>
              <dd>{display?.accountLabel ?? display?.account ?? "-"}</dd>
              {preview && (
                <>
                  <dt>{S.preview}</dt>
                  <dd>
                    {detail.kind === "budget_import"
                      ? S.newTxns(count(preview.new))
                      : S.newRows(count(preview.new))}{" "}
                    · {S.duplicates(count(preview.duplicates))}
                    {count(preview.warnings) > 0 && <> · {S.warnings(count(preview.warnings))}</>}
                    {count(preview.errors) > 0 && <> · {S.errors(count(preview.errors))}</>}
                    {count(preview.reconciliation_mismatches) > 0 && (
                      <> · {S.mismatches(count(preview.reconciliation_mismatches))}</>
                    )}
                  </dd>
                </>
              )}
            </dl>
          )}
          {detail.reviewedAt && (
            <p className="mt-4 text-sm text-fg-muted">
              {P.result}: <DateText value={detail.reviewedAt.slice(0, 10)} />
            </p>
          )}
          {detail.status === "pending" && (
            <div className="mt-6 flex gap-3 border-t border-border pt-4">
              <button type="button" disabled={state.busy} onClick={state.onRejected}>
                {S.reject}
              </button>
              <button
                type="button"
                disabled={state.busy || unsupported}
                onClick={state.onApproved}
                className="rounded-md bg-accent px-4 py-2 text-fg-inverse"
              >
                {detail.nextStrategyVersion === null
                  ? S.approveImport
                  : S.approveAs(detail.nextStrategyVersion)}
              </button>
            </div>
          )}
          <p className="mt-3 text-xs text-fg-muted">{S.rejectChangesNothing}</p>
        </>
      )}
    </>
  );
}

function TextBlock({ title, value }: { title: string; value: string }) {
  return (
    <section className="mt-4">
      <h4 className="font-medium">{title}</h4>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 text-xs">
        {value}
      </pre>
    </section>
  );
}
