import { D, Money as MoneyValue } from "@cashu/domain";
import { Amount, DateText, Money, useVirtualRows } from "@cashu/ui";
import { useRef } from "react";
import { I } from "./Portfolio.strings.js";
import { investmentButton } from "./PortfolioView.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";

const input = "rounded-sm border border-border bg-surface p-2";

/** The actual checked preview and reconciliation, with an explicit unavailable picker boundary. */
export function ImportStepsView({ state }: { state: PortfolioScreenState }) {
  const preview = state.importPreview;
  return (
    <section className="grid gap-3">
      <ol className="flex gap-3" aria-label={I.import}>
        {[I.select, I.transactions, I.reconciliation, I.result].map((label, index) => (
          <li
            key={label}
            aria-current={state.importStep === index + 1 ? "step" : undefined}
            className={state.importStep === index + 1 ? "font-strong text-accent" : "text-fg-muted"}
          >
            {label}
          </li>
        ))}
      </ol>
      {state.importStep === 1 && (
        <>
          <state.importForm.Field name="account">
            {(field) => (
              <label className="grid gap-1">
                {I.account}
                <select
                  className={input}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  <option value="">{I.select}</option>
                  {state.portfolio.accounts.map((account) => (
                    <option key={account.gid} value={account.gid}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </state.importForm.Field>
          <state.importForm.Field name="importer">
            {(field) => (
              <label className="grid gap-1">
                {I.import}
                <select
                  className={input}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {["auto", "cashu", "generic_csv"].map((importer) => (
                    <option key={importer}>{importer}</option>
                  ))}
                </select>
              </label>
            )}
          </state.importForm.Field>
          {state.importDraft.importer === "generic_csv" && (
            <state.importForm.Field name="mappingYaml">
              {(field) => (
                <label className="grid gap-1">
                  {I.import}
                  <textarea
                    className={input}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </label>
              )}
            </state.importForm.Field>
          )}
          {!state.importAvailable && <p>{I.importUnavailable}</p>}
          <button
            type="button"
            className={investmentButton}
            disabled={!state.importAvailable || state.busy}
            onClick={() => void state.importForm.handleSubmit()}
          >
            {I.select}
          </button>
        </>
      )}
      {state.importStep === 2 && preview && (
        <>
          <h3>{preview.fileName}</h3>
          <p>{preview.importer.name ?? preview.importer.id}</p>
          {preview.counts && (
            <dl className="grid grid-cols-2 gap-2">
              <dt>{I.transactions}</dt>
              <dd>
                <Amount value={D(String(preview.counts.rows))} />
              </dd>
              <dt>{I.positions}</dt>
              <dd>
                <Amount value={D(String(preview.counts.positions))} />
              </dd>
            </dl>
          )}
          {preview.warnings.map((warning) => (
            <p key={JSON.stringify(warning)} className="text-tone-warning">
              {warning.message}
            </p>
          ))}
          {preview.errors.map((warning) => (
            <p key={JSON.stringify(warning)} role="alert">
              {warning.message}
            </p>
          ))}
          <PreviewRows state={state} />
          <button type="button" className={investmentButton} onClick={() => state.setImportStep(1)}>
            {I.select}
          </button>
          <button
            type="button"
            className={investmentButton}
            disabled={!preview.canCommit}
            onClick={() => state.setImportStep(3)}
          >
            {I.reconciliation}
          </button>
        </>
      )}
      {state.importStep === 3 && preview && (
        <>
          <h3>{I.reconciliation}</h3>
          {preview.reconciliation?.corrections.map((correction) => (
            <label key={correction.diff.instrumentId} className="flex flex-wrap items-center gap-3">
              <input
                type="checkbox"
                checked={state.importDraft.corrections.includes(correction.diff.instrumentId)}
                onChange={(event) =>
                  state.importForm.setFieldValue("corrections", (current) =>
                    event.target.checked
                      ? [...current, correction.diff.instrumentId]
                      : current.filter((id) => id !== correction.diff.instrumentId),
                  )
                }
              />
              {preview.newInstruments.find(
                (instrument) => instrument.id === correction.diff.instrumentId,
              )?.label ??
                state.instrumentOptions.find(
                  (instrument) => instrument.id === correction.diff.instrumentId,
                )?.label ??
                I.instrument}
              <Amount value={correction.diff.computedQuantity} />
              <Amount value={correction.diff.brokerQuantity} />
            </label>
          ))}
          <button type="button" className={investmentButton} onClick={() => state.setImportStep(2)}>
            {I.transactions}
          </button>
          <button
            type="button"
            className={investmentButton}
            disabled={state.busy || !preview.canCommit || state.importUncertain}
            onClick={() => void state.commitPreview()}
          >
            {I.save}
          </button>
        </>
      )}
      {state.importStep === 4 && state.importOutcome?.status === "committed" && (
        <div role="status">
          <h3>{I.result}</h3>
          <p>
            {I.transactions} <Amount value={D(String(state.importOutcome.result.inserted))} />
          </p>
          <p>
            {I.reconciliation} <Amount value={D(String(state.importOutcome.result.corrections))} />
          </p>
          {state.importOutcome.stagingCleanup === "retained" && <p>{I.stagingRetained}</p>}
          {state.importOutcome.publicationCleanupFailed && <p>{I.publicationCleanup}</p>}
        </div>
      )}
    </section>
  );
}
function PreviewRows({ state }: { state: PortfolioScreenState }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = state.importPreview?.rows ?? [];
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 48,
    overscan: 5,
  });
  const large = rows.length > 50;
  const items = large ? virtual.items : rows.map((_, index) => ({ index, start: 0 }));
  return (
    <div ref={ref} className="max-h-72 overflow-auto">
      <table aria-label={I.transactions} aria-rowcount={rows.length + 1} className="grid w-full">
        <thead>
          <tr className="grid grid-cols-5">
            <th>{I.date}</th>
            <th>{I.transactionType}</th>
            <th>{I.instrument}</th>
            <th>{I.quantity}</th>
            <th>{I.cashAmount}</th>
          </tr>
        </thead>
        <tbody className="relative block" style={large ? { height: virtual.totalSize } : undefined}>
          {items.map((item) => {
            const row = rows[item.index];
            return (
              row && (
                <tr
                  key={row.index}
                  aria-rowindex={item.index + 2}
                  className={`${large ? "absolute left-0 top-0 " : ""}grid h-12 w-full grid-cols-5 text-caption`}
                  style={large ? { transform: `translateY(${item.start}px)` } : undefined}
                >
                  <td>
                    <DateText value={row.tradeDate} />
                  </td>
                  <td>{row.type}</td>
                  <td>{row.instrument?.label}</td>
                  <td>
                    <Amount value={row.quantity} />
                  </td>
                  <td>
                    <Money value={new MoneyValue(row.cashAmount, row.cashCurrency)} />
                  </td>
                </tr>
              )
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
