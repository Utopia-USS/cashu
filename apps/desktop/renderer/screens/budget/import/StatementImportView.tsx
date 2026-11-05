// The statement import drawer (ab24ab6 modules/budget/ImportDrawer.tsx) on the shared ImportDrawer: the source
// radios with the Open Banking command or notice, the file step's fields. Pure: state from useStatementImport.
import { S } from "@cashu/i18n/budget/ImportDrawer.strings";
import {
  Button,
  CodeLine,
  ImportDrawer,
  importHintCls,
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

export function StatementImportView({ state }: { state: StatementImportState }) {
  const f = state.footer;
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
    ) : (
      <>
        <Button onPress={state.onBack}>{f.back}</Button>
        <span className="flex-1" />
        <Button variant="primary" disabled={f.runDisabled} onPress={state.onPreview}>
          {f.run}
        </Button>
      </>
    );
  return (
    <ImportDrawer
      title={state.title}
      steps={state.steps}
      step={state.step}
      error={state.error}
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
                <code>CASHU_EB_APP_ID</code>
                {S.ebMissing[1]}
                <code>.env</code>
                {S.ebMissing[2]}
                <code>enablebanking_private.pem</code>
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
              onChange={(e) => state.onFile(e.target.files?.[0]?.name ?? null)}
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
          {state.accounts.length > 0 && (
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
    </ImportDrawer>
  );
}
