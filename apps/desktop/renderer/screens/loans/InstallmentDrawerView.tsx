// Installment matching (ab24ab6 modules/loans/Drawers.tsx `InstallmentDrawer`, `set-payment`): a title phrase or
// the bank's IBAN, with the recent regular payments as phrase candidates. Pure; refused in privacy mode.
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/loans/Drawers.strings";
import {
  Button,
  Drawer,
  FieldNote,
  Notice,
  Seg,
  Select,
  SettingRow,
  Tag,
  TextField,
} from "@cashu/ui";
import type { PaymentMode } from "./loanForm.js";
import { PHRASE_EXAMPLE } from "./loansModel.js";
import type { LoansState } from "./useLoansScreen.js";

/** Old `.field` frame around the method switch: 12px muted caption, 4px gap, 12px below. */
const fieldCls = "mb-3 grid gap-1 text-xs text-fg-muted";
/** Old `.kicker` (11px uppercase .06em muted 600) with its inline margin 14px 0 4px. */
const kickerCls = "mt-3.5 mb-1 text-2xs font-strong uppercase tracking-eyebrow text-fg-muted";

export function InstallmentDrawerView({ state }: { state: LoansState }) {
  if (state.privacy || state.drawer?.kind !== "payment") return null;
  const p = state.payment;
  const value = p.mode === "text" ? p.text : p.iban;
  const clear = p.stored ? (
    <Button variant="link" size="lg" disabled={state.busy} onPress={() => p.send("")}>
      {S.clear}
    </Button>
  ) : undefined;
  return (
    <Drawer
      title={S.payments}
      label={S.payments}
      width={520}
      onClose={state.close}
      tag={p.name != null ? <Tag>{p.name}</Tag> : undefined}
      footer={
        <>
          <span className="flex-1" />
          <Button onPress={state.close}>{C.cancel}</Button>
          <Button
            variant="primary"
            disabled={state.busy || !value.trim() || p.name == null}
            onPress={() => p.send(value.trim())}
          >
            {state.busy ? S.saving : C.save}
          </Button>
        </>
      }
    >
      {state.err && <Notice tone="negative">{state.err}</Notice>}
      {p.loans.length > 1 && (
        <Select
          id="in-loan"
          label={S.loan}
          value={p.account}
          onChange={p.pick}
          options={p.loans}
          className="mb-3"
        />
      )}
      <div className={fieldCls}>
        <span>{S.method}</span>
        <div>
          <Seg<PaymentMode>
            label={S.method}
            items={[
              [S.byPhrase, "text"],
              [S.byIban, "iban"],
            ]}
            value={p.mode}
            onChange={p.setMode}
          />
        </div>
      </div>
      {p.mode === "text" ? (
        <>
          <TextField
            id="in-t"
            label={S.phrase}
            value={p.text}
            placeholder={PHRASE_EXAMPLE}
            maxLength={120}
            autoComplete="off"
            autoFocus
            onChange={p.setText}
            trailing={clear}
            after={<FieldNote>{S.phraseHint}</FieldNote>}
            className="mb-3"
          />
          {p.candidates.length > 0 && (
            <>
              <div className={kickerCls}>{S.recent}</div>
              {p.candidates.map((c) => (
                <SettingRow
                  key={c.key}
                  title={c.payee}
                  detail={c.detail}
                  action={
                    <Button variant="link" size="lg" onPress={() => p.setText(c.payee)}>
                      {S.use}
                    </Button>
                  }
                />
              ))}
            </>
          )}
        </>
      ) : (
        <TextField
          id="in-i"
          label={S.ibanLabel}
          value={p.iban}
          autoComplete="off"
          inputMode="numeric"
          placeholder={p.storedTail ? S.newNumber : undefined}
          onChange={p.setIban}
          before={p.storedTail ? <FieldNote>{S.storedIban(p.storedTail)}</FieldNote> : undefined}
          trailing={clear}
          after={<FieldNote>{S.ibanHint}</FieldNote>}
          className="mb-3"
        />
      )}
    </Drawer>
  );
}
