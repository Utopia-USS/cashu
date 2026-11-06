// Fetch bindings of one connector in the current profile (ab24ab6 core/ConnectorBindings.tsx): the binding form
// (account, parameters, auto save), a row per bound account (its sync line and rate-limit tag) that syncs on demand
// with its failure block (kind line, stderr tail), and the edit form for the write-only secrets and unbinding. Native bindings keep their parameters once bound, so the edit
// form holds the secrets only. Pure view (form drafts are view state).
import { S as CB } from "@cashu/i18n/core/ConnectorBindings.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { CS } from "@cashu/i18n/core/connectors.strings";
import {
  Button,
  FieldNote,
  FormRow,
  importCheckCls,
  Kicker,
  RunError,
  Select,
  SettingRow,
  Switch,
  Tag,
  TextField,
} from "@cashu/ui";
import { useEffect, useState } from "react";
import { T } from "../Settings.strings.js";
import type { SettingsScreenState } from "../useSettingsScreen.js";
import {
  type Binding,
  backoffActive,
  type Connector,
  kindLine,
  lastSyncText,
  runsOf,
  when,
} from "./connectorsModel.js";

const controls = "flex flex-wrap items-center gap-2";
/** Old `.bindform`: the chip panel of the binding form. */
const bindform = "my-2 rounded-md bg-chip px-3.5 py-3";

export function BindingsPanelView({
  connector,
  state,
}: {
  connector: Connector;
  state: SettingsScreenState;
}) {
  const busy = state.connectorBusy;
  const snapshot = state.connectorSnapshot;
  const approved = connector.approval === "approved";
  const mine = snapshot?.bindings.filter((b) => b.connector_id === connector.id) ?? [];
  const [form, setForm] = useState<"new" | string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const labelOf = (binding: Binding) =>
    snapshot?.accounts.find((a) => a.gid === binding.account)?.name ?? binding.account;
  const free = state
    .connectorAccounts(connector)
    .filter((account) => !mine.some((b) => b.account === account.gid));
  const sync = async (binding: Binding) => {
    setSyncing(binding.gid);
    try {
      await state.onConnectorAction({ op: "run", binding: binding.gid });
    } finally {
      setSyncing(null);
    }
  };
  return (
    <>
      <Kicker title={CB.bindings(state.current?.name ?? "")}>
        <Tag>{mine.length}</Tag>
        <span className="flex-1" />
        {form !== "new" && (
          <Button
            disabled={!approved}
            title={!approved ? CB.approveFirst : undefined}
            onPress={() => setForm("new")}
          >
            {CB.bindAccount}
          </Button>
        )}
      </Kicker>
      {form === "new" && (
        <BindingForm
          connector={connector}
          state={state}
          accounts={free}
          bound={mine}
          onDone={() => setForm(null)}
        />
      )}
      {mine.map((binding) => {
        const failure = state.connectorRunFailure(binding.gid);
        const fetchState = state.connectorActivity.bindings.find((b) => b.binding === binding.gid);
        // The sync just finished: this binding's newest run is the one that failed.
        const lastRun = runsOf(state.connectorActivity.runs, connector.id).find(
          (run) => run.binding === binding.gid,
        );
        return form === binding.gid ? (
          <SecretsForm
            key={binding.gid}
            connector={connector}
            binding={binding}
            label={labelOf(binding)}
            state={state}
            onDone={() => setForm(null)}
          />
        ) : (
          <SettingRow
            key={binding.gid}
            title={
              <>
                {labelOf(binding)}
                {binding.auto_commit ? (
                  <Tag tone="positive" title={CS.autoRule}>
                    {CB.autoCommit}
                  </Tag>
                ) : (
                  <Tag title={CB.waitsTitle}>{CB.toApprove}</Tag>
                )}
                {backoffActive(fetchState?.backoffUntil) && (
                  <Tag tone="warning" title={CB.rateLimitedTitle}>
                    {CB.apiLimitUntil(when(fetchState?.backoffUntil))}
                  </Tag>
                )}
              </>
            }
            detail={lastSyncText(fetchState)}
            action={
              <div className={controls}>
                <Button disabled={busy || !approved} onPress={() => void sync(binding)}>
                  {syncing === binding.gid ? CB.fetching : CB.sync}
                </Button>
                <Button variant="link" size="lg" onPress={() => setForm(binding.gid)}>
                  {C.edit}
                </Button>
              </div>
            }
          >
            {failure && (
              <RunError
                title={kindLine(
                  lastRun?.errorKind ?? failure.code ?? "internal",
                  connector.timeoutS,
                )}
                source={connector.name}
                details={lastRun?.stderrTail}
                className="mt-1.5"
              />
            )}
          </SettingRow>
        );
      })}
      {snapshot && !mine.length && form !== "new" && (
        <div className="py-1.5 text-sm text-fg-muted">
          {approved ? CB.noBindings : CB.bindingsAfterApproval}
        </div>
      )}
    </>
  );
}

/** A new binding: the account, the connector's parameters, auto save (old `BindingForm` without `binding`). */
function BindingForm({
  connector,
  state,
  accounts,
  bound,
  onDone,
}: {
  connector: Connector;
  state: SettingsScreenState;
  accounts: ReturnType<SettingsScreenState["connectorAccounts"]>;
  bound: readonly Binding[];
  onDone(): void;
}) {
  const busy = state.connectorBusy;
  const [chosen, setChosen] = useState<string | null>(null);
  const account =
    chosen && accounts.some((a) => a.gid === chosen) ? chosen : (accounts[0]?.gid ?? "");
  const [params, setParams] = useState<Record<string, string | boolean>>({});
  const [auto, setAuto] = useState(false);
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const added = !!saved && bound.some((b) => b.account === saved);
  // the form closes once the new binding is in the list
  useEffect(() => {
    if (added) onDone();
  }, [added, onDone]);
  const missing = (id: string) => {
    const value = params[id];
    return value === undefined || (typeof value === "string" && !value.trim());
  };
  const save = async () => {
    setTried(true);
    if (connector.params.some((p) => p.required && p.type !== "boolean" && missing(p.id))) return;
    if (!account) return;
    setSaved(account);
    await state.bindConnector(connector, account, params, auto);
  };
  return (
    <div className={bindform}>
      {accounts.length ? (
        <Select
          label={CB.account}
          value={account}
          disabled={busy}
          onChange={setChosen}
          options={accounts.map((a) => ({ value: a.gid, label: a.name }))}
          className="mb-3"
        />
      ) : (
        <div className="mb-3 grid gap-1 text-xs text-fg-muted">
          {CB.account}
          <span className="text-sm text-fg">{CB.allBound}</span>
        </div>
      )}
      {connector.params.length > 0 && (
        <FormRow>
          {connector.params.map((param) =>
            param.type === "boolean" ? (
              <label key={param.id} className="mb-3 flex items-center gap-1.5 text-sm text-fg">
                <input
                  type="checkbox"
                  className={importCheckCls}
                  checked={params[param.id] === true}
                  disabled={busy}
                  onChange={(event) =>
                    setParams((old) => ({ ...old, [param.id]: event.target.checked }))
                  }
                />
                {param.label || T.connectorParam}
              </label>
            ) : (
              <TextField
                key={param.id}
                label={`${param.label || T.connectorParam}${param.required ? " *" : ""}`}
                type={param.type === "date" ? "date" : "text"}
                inputMode={param.type === "number" ? "decimal" : undefined}
                numeric={param.type === "number"}
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={typeof params[param.id] === "string" ? (params[param.id] as string) : ""}
                onChange={(value) => setParams((old) => ({ ...old, [param.id]: value }))}
                className="mb-3"
                after={
                  tried && param.required && missing(param.id) ? (
                    <FieldNote tone="negative">{CB.required}</FieldNote>
                  ) : null
                }
              />
            ),
          )}
        </FormRow>
      )}
      <div className={`${controls} mb-2.5 text-sm`}>
        <Switch
          on={auto}
          label={CB.autoCommitLabel}
          title={CS.autoRule}
          onChange={setAuto}
          disabled={busy}
        />
        <span title={CS.autoRule}>{CB.autoCommitLabel}</span>
        <Tag>{CB.afterFirstImport}</Tag>
      </div>
      {connector.secrets.length > 0 && (
        <FieldNote className="mb-2.5 block">{CB.keychainHint}</FieldNote>
      )}
      <div className={`${controls} justify-end`}>
        <span className="flex-1" />
        <Button disabled={busy} onPress={onDone}>
          {C.cancel}
        </Button>
        <Button variant="primary" disabled={busy || !accounts.length} onPress={() => void save()}>
          {busy && saved ? CB.saving : C.save}
        </Button>
      </div>
    </div>
  );
}

/** A bound account's write-only secrets and unbinding (old `BindingForm` with `binding`). */
function SecretsForm({
  connector,
  binding,
  label,
  state,
  onDone,
}: {
  connector: Connector;
  binding: Binding;
  label: string;
  state: SettingsScreenState;
  onDone(): void;
}) {
  const busy = state.connectorBusy;
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const typed = Object.entries(secrets).filter(([, value]) => value.trim());
  const save = async () => {
    for (const [secret, value] of typed)
      await state.onConnectorAction({
        op: "setSecret",
        binding: binding.gid,
        secret,
        value: value.trim(),
      });
    onDone();
  };
  return (
    <div className={bindform}>
      <div className="mb-2.5 text-sm">
        {CB.accountLabel}
        <b>{label}</b>
      </div>
      {connector.secrets.map((secret) => (
        <TextField
          key={secret.id}
          label={secret.label || T.connectorSecret}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          placeholder={CB.pasteKey}
          disabled={busy}
          value={secrets[secret.id] ?? ""}
          onChange={(value) => setSecrets((old) => ({ ...old, [secret.id]: value }))}
          className="mb-3"
          trailing={
            <Button
              variant="link"
              size="lg"
              disabled={busy}
              onPress={() =>
                void state.onConnectorAction({
                  op: "clearSecret",
                  binding: binding.gid,
                  secret: secret.id,
                })
              }
            >
              {CB.clear}
            </Button>
          }
        />
      ))}
      {connector.secrets.length > 0 && (
        <FieldNote className="-mt-1.5 mb-2.5 block">{CB.keychainHint}</FieldNote>
      )}
      {confirm ? (
        <div className={`${controls} justify-end text-sm`}>
          <span>{CB.unbindQ(label)}</span>
          <span className="flex-1" />
          <Button disabled={busy} onPress={() => setConfirm(false)}>
            {C.cancel}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onPress={() => void state.onConnectorAction({ op: "unbind", binding: binding.gid })}
          >
            {CB.yesUnbind}
          </Button>
        </div>
      ) : (
        <div className={`${controls} justify-end`}>
          <Button variant="link" size="lg" disabled={busy} onPress={() => setConfirm(true)}>
            {CB.unbind}
          </Button>
          <span className="flex-1" />
          <Button disabled={busy} onPress={onDone}>
            {C.cancel}
          </Button>
          <Button variant="primary" disabled={busy || !typed.length} onPress={() => void save()}>
            {busy ? CB.saving : C.save}
          </Button>
        </div>
      )}
    </div>
  );
}
