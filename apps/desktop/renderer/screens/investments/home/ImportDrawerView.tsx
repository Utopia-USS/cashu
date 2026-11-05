// The Import drawer (ab24ab6 modules/investments/Drawers.tsx ImportDrawer) in the shared side Drawer: stepper,
// account radios, importer and mapping, the checked preview with the reconciliation, the result. Pure: the state
// and every formatted row come from useImportDrawer.ts.
import { S } from "@cashu/i18n/investments/Drawers.strings";
import {
  Button,
  ImportCounts,
  ImportDone,
  ImportDrawer,
  ImportTable,
  importTable,
  Notice,
  RadioList,
  Select,
  Tag,
  TextField,
} from "@cashu/ui";
import type { ImportDrawerState, ImportWarningText } from "./useImportDrawer.js";

const td = importTable.td();
const num = importTable.td(true);
const tones = { positive: "text-positive", negative: "text-negative" } as const;

function Warning({ w }: { w: ImportWarningText }) {
  return (
    <>
      {w.text}
      {w.detail && <span className="text-xs text-fg-muted"> ({w.detail})</span>}
    </>
  );
}

export function ImportDrawerView({ state }: { state: ImportDrawerState }) {
  const f = state.footer;
  const footer =
    f.kind === "preview" ? (
      <>
        <Button onPress={state.onBack}>{S.back}</Button>
        <span className="flex-1" />
        <Button variant="primary" disabled={f.commitDisabled} onPress={state.onCommit}>
          {f.commit}
        </Button>
      </>
    ) : f.kind === "file" ? (
      <>
        {f.back && <Button onPress={state.onBack}>{S.back}</Button>}
        <span className="flex-1" />
        <Button variant="link" size="lg" onPress={state.onManual}>
          {S.addManually}
        </Button>
        <Button variant="primary" disabled={f.runDisabled} onPress={state.onPreview}>
          {f.run}
        </Button>
      </>
    ) : f.kind === "account" ? (
      <>
        <span className="flex-1" />
        <Button variant="primary" disabled={f.nextDisabled} onPress={state.onNext}>
          {f.next}
        </Button>
      </>
    ) : (
      <>
        <span className="flex-1" />
        <Button onPress={state.onClose}>{f.close}</Button>
      </>
    );
  const p = state.preview;
  return (
    <ImportDrawer
      title={state.title}
      tag={state.accountTag}
      steps={state.steps}
      step={state.step}
      error={state.error}
      footer={footer}
      onClose={state.onClose}
    >
      {state.step === 0 && (
        <>
          {state.accountOptions.length ? (
            <RadioList
              name="imp-acc"
              value={state.account}
              onChange={state.onAccount}
              options={state.accountOptions}
            />
          ) : (
            <div className="text-sm text-fg-muted">{S.addAccountFirst}</div>
          )}
          <Button variant="link" size="lg" onPress={state.onAddAccount}>
            {S.addAccount}
          </Button>
        </>
      )}
      {state.step === 1 && (
        <>
          <div className="mb-3 grid gap-1">
            <Select
              label={S.importer}
              value={state.importer}
              onChange={state.onImporter}
              options={state.importerOptions}
            />
            {state.remembered && <span className="text-xs text-fg-muted">{state.remembered}</span>}
          </div>
          {state.mapping != null && (
            <TextField
              label={state.mappingLabel}
              multiline
              value={state.mapping}
              placeholder={S.mappingHint}
              onChange={state.onMapping}
              className="mb-3"
            />
          )}
        </>
      )}
      {state.step === 2 && p && (
        <>
          <div className="mb-2.5 text-xs-plus text-fg-muted">
            <code>{p.meta.file}</code> {"·"} {p.meta.importer}
            <Button variant="link" size="md" onPress={state.onChangeImporter}>
              {S.changeImporter}
            </Button>
          </div>
          {p.errors.length > 0 && (
            <Notice tone="negative">
              <b>{S.fileErrors}</b>
              <ul className="mt-1.5 mb-0 pl-4.5">
                {p.errors.map((w, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no ids.
                  <li key={index}>
                    <Warning w={w} />
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {p.before && <Notice tone="warning">{p.before}</Notice>}
          <ImportCounts
            fresh={p.counts.fresh}
            duplicates={p.counts.duplicates}
            skipped={p.counts.skipped}
            filter={{ label: S.onlyProblems, on: p.problems, onChange: p.onProblems }}
          />
          <ImportTable
            columns={[
              { key: "date", label: S.colDate },
              { key: "type", label: S.colType },
              { key: "instrument", label: S.colInstrument },
              { key: "qty", label: S.colQty, num: true },
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
                <td className={td}>{r.type}</td>
                <td className={td}>
                  {r.instrument ? (
                    <>
                      {r.instrument} {r.newInstrument && <Tag tone="info">{S.newInstrument}</Tag>}
                    </>
                  ) : (
                    <span className="text-fg-muted">-</span>
                  )}
                </td>
                <td className={num}>{r.quantity}</td>
                <td className={`${num} ${r.tone ? tones[r.tone] : ""}`}>{r.amount}</td>
                <td className={td}>
                  {r.duplicate ? <Tag>{S.duplicate}</Tag> : <Tag tone="positive">{S.new}</Tag>}
                </td>
              </tr>
            ))}
            {p.skipped.map((w, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skipped rows have no ids.
              <tr key={`s${index}`}>
                <td colSpan={4} className={`${td} text-fg-muted`}>
                  <Warning w={w} />
                </td>
                <td className={num}>-</td>
                <td className={td}>
                  <Tag tone="warning">{S.skipped}</Tag>{" "}
                  <Button variant="link" size="sm" onPress={state.onManual}>
                    {S.addManually}
                  </Button>
                </td>
              </tr>
            ))}
          </ImportTable>
          {p.recon && (
            <>
              <div className="mt-4 mb-1.5 flex flex-wrap items-center gap-2">
                <strong className="text-md">{S.reconciliation}</strong>
                {p.recon.snapshot && <Tag>{p.recon.snapshot}</Tag>}
                <span className="flex-1" />
                <span className="text-xs text-fg-muted">{p.recon.state}</span>
              </div>
              <table className={importTable.table}>
                <thead>
                  <tr>
                    <th className={importTable.th()}>{S.colInstrument}</th>
                    <th className={importTable.th(true)}>{S.colAtBroker}</th>
                    <th className={importTable.th(true)}>{S.colAfterImport}</th>
                    <th className={importTable.th(true)}>{S.colDiff}</th>
                    <th className={importTable.th()} title={S.correctionTitle}>
                      {S.colCorrection}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {p.recon.rows.map((d) => (
                    <tr key={d.key} className={d.delta ? "bg-warning-bg" : undefined}>
                      <td className={td}>{d.label}</td>
                      <td className={num}>{d.broker}</td>
                      <td className={num}>{d.computed}</td>
                      <td className={`${num} ${d.delta ? "font-strong text-warning" : ""}`}>
                        {d.delta ?? <span className="text-fg-muted">-</span>}
                      </td>
                      <td className={td}>
                        {d.correction ? (
                          <label className="flex items-center gap-1.5 text-xs-plus">
                            <input
                              type="checkbox"
                              className="size-3.75 accent-accent"
                              checked={d.correction.on}
                              onChange={(e) => d.correction?.onChange(e.target.checked)}
                            />
                            {d.correction.text}
                          </label>
                        ) : (
                          <span className="text-fg-muted">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {p.newOnes && (
            <Notice tone="info" className="mt-3.5">
              {p.newOnes}
            </Notice>
          )}
        </>
      )}
      {state.step === 3 && state.done && (
        <ImportDone
          title={state.done.title}
          line={state.done.duplicates}
          actions={
            state.done.classify ? (
              <Button variant="primary" onPress={state.onClassify}>
                {state.done.classify}
              </Button>
            ) : undefined
          }
        />
      )}
    </ImportDrawer>
  );
}
