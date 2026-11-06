// The statement import drawer (ab24ab6 modules/budget/ImportDrawer.tsx) on the shared ImportDrawer: the source
// radios with the Open Banking command or notice, the file step's fields, the preview (account, counts, rows) and
// the done block. Pure: state from useStatementImport.
import { S } from "@cashu/i18n/budget/ImportDrawer.strings";
import {
  Button,
  CodeLine,
  ImportCounts,
  ImportDone,
  ImportDrawer,
  ImportTable,
  importHintCls,
  importTable,
  Notice,
  RadioList,
  Select,
  Tag,
  TextField,
} from "@cashu/ui";
import type { StatementImportState } from "./useStatementImport.js";

/** Old `.field` (grid, 4px gap, 12px below) with the bare file input (13px, 6px 9px). */
const field = "mb-3 grid gap-1";
const fieldLabel = "text-xs text-fg-muted";
const fileInput =
  "w-full rounded-control border border-border bg-chip px-2.25 py-1.5 text-sm text-fg focus:border-accent focus:outline-none";
const td = importTable.td();
const num = importTable.td(true);
const tones = { positive: "text-positive", negative: "text-negative" } as const;
/** Old global `code`: 0.92em of the surrounding text, monospace, no ligatures. */
const code = "font-mono text-code-ui [font-variant-ligatures:none]";

export function StatementImportView({ state }: { state: StatementImportState }) {
  const f = state.footer;
  const p = state.preview;
  const footer =
    f.kind === "openBanking" ? (
      <>
        <span className="flex-1" />
        <Button onPress={state.onInstructions}>{f.instructions}</Button>
        <Button onPress={state.onClose}>{f.close}</Button>
      </>
    ) : f.kind === "source" ? (
      <>
        <span className="flex-1" />
        <Button variant="primary" disabled={f.nextDisabled} onPress={state.onNext}>
          {f.next}
        </Button>
      </>
    ) : f.kind === "file" ? (
      <>
        <Button onPress={state.onBack}>{f.back}</Button>
        <span className="flex-1" />
        <Button variant="primary" disabled={f.runDisabled} onPress={state.onPreview}>
          {f.run}
        </Button>
      </>
    ) : f.kind === "preview" ? (
      <>
        <Button onPress={state.onBackToFile}>{f.back}</Button>
        <span className="flex-1" />
        <Button variant="primary" disabled={f.commitDisabled} onPress={state.onCommit}>
          {f.commit}
        </Button>
      </>
    ) : (
      <>
        <span className="flex-1" />
        <Button onPress={state.onClose}>{f.close}</Button>
      </>
    );
  return (
    <ImportDrawer
      title={state.title}
      tag={state.tag}
      steps={state.steps}
      step={state.step}
      error={
        state.error && (
          <>
            {state.error}
            {state.errorDetail && (
              <div className={`${importHintCls} mt-0.5 whitespace-pre-line`}>
                {state.errorDetail}
              </div>
            )}
          </>
        )
      }
      footer={footer}
      onClose={state.onClose}
    >
      {state.step === 0 && (
        <>
          <RadioList
            name="imp-src"
            value={state.source}
            onChange={state.onSource}
            options={state.sources.map((s) => ({
              value: s.value,
              title: s.title,
              desc: s.desc,
              tag: s.warn ? (
                <Tag tone="warning">{s.warn}</Tag>
              ) : s.tag ? (
                <Tag>{s.tag}</Tag>
              ) : undefined,
              tooltip: s.tooltip,
              disabled: s.disabled,
            }))}
          />
          {state.openBanking &&
            (state.ebConfigured ? (
              <>
                <CodeLine command={state.ebCommand} onCopy={state.onCopy} />
                <div className={importHintCls}>{S.obHint}</div>
              </>
            ) : (
              <Notice tone="warning">
                {S.ebMissing[0]}
                <code className={code}>CASHU_EB_APP_ID</code>
                {S.ebMissing[1]}
                <code className={code}>.env</code>
                {S.ebMissing[2]}
                <code className={code}>enablebanking_private.pem</code>
                {S.ebMissing[3]}
              </Notice>
            ))}
        </>
      )}
      {state.step === 1 && (
        <>
          <div className={field}>
            <label htmlFor="st-file" className={fieldLabel}>
              {S.bankFile}
            </label>
            <input
              key={state.fileKey}
              id="st-file"
              type="file"
              accept=".csv,.json,text/csv,application/json"
              data-autofocus
              className={fileInput}
              onChange={(e) => state.onFile(e.target.files?.[0] ?? null)}
            />
            <span className={importHintCls}>{S.fileStays}</span>
          </div>
          {state.showBank && (
            <Select
              label={S.bank}
              value={state.bank}
              options={state.bankOptions}
              onChange={state.onBank}
              className="mb-3"
            />
          )}
          {state.hasAccounts && (
            <div className={field}>
              <Select
                label={S.account}
                value={state.accountId}
                options={state.accountOptions}
                onChange={state.onAccount}
              />
              <span className={importHintCls}>{S.accountHint}</span>
            </div>
          )}
          {!state.accountId && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(--spacing(45),1fr))] gap-3">
              <Select
                label={S.accountType}
                value={state.accountType}
                options={state.typeOptions}
                onChange={state.onAccountType}
                className="mb-3"
              />
              <TextField
                label={S.accountName}
                value={state.accountName}
                placeholder={S.fromFile}
                maxLength={80}
                autoComplete="off"
                onChange={state.onAccountName}
                className="mb-3"
              />
            </div>
          )}
        </>
      )}
      {state.step === 2 && p && (
        <>
          <div className="mb-2.5 text-xs-plus text-fg-muted">
            <code className={code}>{p.fileName}</code>
            {p.meta}
            <Button variant="link" size="md" onPress={state.onChange}>
              {S.change}
            </Button>
          </div>
          <div className="mb-2.5 text-sm">
            {S.accountPrefix}
            <b>{p.account}</b>{" "}
            {p.accountTag.tone ? (
              <Tag tone={p.accountTag.tone}>{p.accountTag.text}</Tag>
            ) : (
              <Tag>{p.accountTag.text}</Tag>
            )}
          </div>
          {p.before && <Notice tone="warning">{p.before}</Notice>}
          {p.warnings.length > 0 && (
            <Notice tone="warning">
              <ul className="m-0 pl-4.5">
                {p.warnings.map((w, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no ids.
                  <li key={index}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}
          <ImportCounts
            fresh={p.counts.fresh}
            duplicates={p.counts.duplicates}
            duplicatesTitle={p.counts.duplicatesTitle}
            skipped={p.counts.skipped}
            skippedTitle={S.skippedTitle}
            filter={{ label: S.onlyNew, on: p.onlyNew, onChange: p.onOnlyNew }}
          />
          {p.allInDb && <Notice tone="info">{S.allInDb}</Notice>}
          <ImportTable
            columns={[
              { key: "date", label: S.colDate },
              { key: "title", label: S.colTitle },
              { key: "counterparty", label: S.colCounterparty },
              { key: "amount", label: S.colAmount, num: true },
              { key: "status", label: S.colStatus },
            ]}
            more={
              p.more
                ? {
                    text: p.more,
                    action: (
                      <Button variant="link" size="sm" onPress={p.onAll}>
                        {S.showAll}
                      </Button>
                    ),
                  }
                : null
            }
            empty={p.empty}
          >
            {p.rows.map((r) => (
              <tr key={r.key} className={r.duplicate ? "text-fg-muted" : undefined}>
                <td className={td}>{r.date}</td>
                <td className={td}>{r.title ?? <span className="text-fg-muted">-</span>}</td>
                <td className={r.counterparty ? td : `${td} text-fg-muted`}>
                  {r.counterparty ?? "-"}
                </td>
                <td className={`${num} ${r.tone ? tones[r.tone] : ""}`}>{r.amount}</td>
                <td className={td}>
                  {r.duplicate ? <Tag>{S.duplicate}</Tag> : <Tag tone="positive">{S.new}</Tag>}
                </td>
              </tr>
            ))}
          </ImportTable>
        </>
      )}
      {state.step === 3 && state.done && (
        <ImportDone
          title={state.done.title}
          line={state.done.line}
          actions={
            <>
              <Button onPress={state.onAgain}>{S.importAnother}</Button>
              {state.done.expenses && (
                <Button variant="primary" onPress={state.onExpenses}>
                  {S.expensesLink}
                </Button>
              )}
            </>
          }
        />
      )}
    </ImportDrawer>
  );
}
