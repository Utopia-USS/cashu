// One installed connector (ab24ab6 core/ConnectorDrawer.tsx): the state notices, what the owner approves first
// (command, interpreter, time limit, network, secrets, parameters, checksum), the quiet facts, the profile's fetch
// bindings, the run history, then approve / turn off / delete in the foot. Approve sends the digest and interpreter
// this drawer shows. The native snapshot has no files, install time or source: those parts are left out. Pure view
// (confirm step, opened run details = view state).

import { S } from "@cashu/i18n/core/ConnectorDrawer.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { STATUS } from "@cashu/i18n/core/connectors.strings";
import {
  Button,
  Drawer,
  dataTableCls,
  dataTdCls,
  dataThCls,
  FieldNote,
  KeyValues,
  Kicker,
  Notice,
  RunError,
  scrollCls,
  Tag,
} from "@cashu/ui";
import { useState } from "react";
import { T } from "../Settings.strings.js";
import { tagTone } from "../settingsModel.js";
import type { SettingsScreenState } from "../useSettingsScreen.js";
import { BindingsPanelView } from "./BindingsPanelView.js";
import {
  type Connector,
  type ConnectorRun,
  durationText,
  kindLabel,
  kindLine,
  kindShort,
  moduleLabel,
  outcomeLabel,
  outcomeTone,
  runsOf,
  shortSha,
  when,
} from "./connectorsModel.js";

const code = "font-mono text-code-ui [font-variant-ligatures:none] wrap-anywhere";

export function StatusTag({ status }: { status: string }) {
  const known = status in STATUS ? STATUS[status as keyof typeof STATUS] : null;
  const [text, tone, solid] = known ?? [status, undefined, false];
  return (
    <Tag tone={tagTone(tone)} solid={solid}>
      {text}
    </Tag>
  );
}

export function ConnectorDrawerView({
  connector,
  state,
  onClose,
}: {
  connector: Connector;
  state: SettingsScreenState;
  onClose(): void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = state.connectorBusy;
  const status = connector.approval;
  const fetch = connector.kind === "fetch";
  const interpreter = connector.interpreter;
  const run = connector.run ?? [];
  const local = run[0]?.startsWith("./") ?? false;
  const approve = () => {
    if (!interpreter) return;
    // the values this drawer showed, never re-read before sending
    return state.onConnectorAction({
      op: "approve",
      id: connector.id,
      digest: connector.contentSha256,
      interpreter,
    });
  };
  const footer = confirmDelete ? (
    <>
      <span className="text-sm">{T.connectorRemoveAllConfirm}</span>
      <span className="flex-1" />
      <Button disabled={busy} onPress={() => setConfirmDelete(false)}>
        {C.cancel}
      </Button>
      <Button
        variant="danger"
        disabled={busy}
        onPress={() => state.onConnectorAction({ op: "remove", id: connector.id, allVaults: true })}
      >
        {S.yesDelete}
      </Button>
    </>
  ) : (
    <>
      <Button disabled={busy} title={T.connectorRemoveAll} onPress={() => setConfirmDelete(true)}>
        {C.remove}
      </Button>
      {(status === "changed" || status === "approved") && (
        <Button
          disabled={busy}
          onPress={() => state.onConnectorAction({ op: "disable", id: connector.id })}
        >
          {S.turnOff}
        </Button>
      )}
      <span className="flex-1" />
      {status !== "approved" && (
        <Button variant="primary" disabled={busy || !interpreter} onPress={approve}>
          {status === "changed"
            ? S.approveAgain
            : status === "disabled"
              ? S.approveEnable
              : S.approve}
        </Button>
      )}
    </>
  );
  return (
    <Drawer
      title={connector.name}
      label={S.connector}
      tag={<StatusTag status={status} />}
      width={640}
      footer={footer}
      onClose={onClose}
    >
      {status === "changed" && (
        <Notice tone="warning">
          {S.filesChanged("")} {S.wontRun}
        </Notice>
      )}
      {!interpreter && (
        <Notice tone="negative">
          {T.connectorInterpreter}: {T.unavailable}
        </Notice>
      )}
      {status === "disabled" && <Notice>{S.disabledNote}</Notice>}
      <Kicker title={S.whatYouApprove} />
      <KeyValues
        keyWidth="narrow"
        baseline
        rows={[
          {
            key: "command",
            label: S.command,
            block: true,
            value: (
              <>
                <code className={`${code} font-strong`}>{run.join(" ") || "-"}</code>
                <div className="mt-0.5">
                  {local ? (
                    <FieldNote>{S.localExec}</FieldNote>
                  ) : (
                    <>
                      <FieldNote>{S.interpreter}</FieldNote>
                      <code className={`${code} text-xs`}>{interpreter ?? "-"}</code>
                    </>
                  )}
                </div>
              </>
            ),
          },
          ...(connector.timeoutS !== undefined
            ? [
                {
                  key: "timeout",
                  label: S.timeout,
                  value: (
                    <>
                      <b>{connector.timeoutS} s</b>
                      {connector.kind === "file" && <FieldNote>{S.fileDetect}</FieldNote>}
                    </>
                  ),
                },
              ]
            : []),
          {
            key: "network",
            label: S.network,
            value: fetch ? (
              <>
                {(connector.hosts ?? []).map((host) => (
                  <code key={host} className={`${code} font-strong`}>
                    {host}
                  </code>
                ))}
                <FieldNote>{S.hostsOnly}</FieldNote>
              </>
            ) : (
              <>
                <b>{S.none}</b>
                <FieldNote>{S.noNetwork}</FieldNote>
              </>
            ),
          },
          ...(fetch && connector.secrets.length > 0
            ? [
                {
                  key: "secrets",
                  label: S.secrets,
                  block: true,
                  value: (
                    <>
                      {connector.secrets.map((secret) => (
                        <div key={secret.id}>
                          <b>{secret.label}</b> <FieldNote>({secret.id})</FieldNote>
                        </div>
                      ))}
                      <FieldNote>{S.secretsHint}</FieldNote>
                    </>
                  ),
                },
              ]
            : []),
          ...(fetch && connector.params.length > 0
            ? [
                {
                  key: "params",
                  label: S.params,
                  value: (
                    <>
                      {connector.params
                        .map((param) => `${param.label}${param.required ? " *" : ""}`)
                        .join(" · ")}
                      {connector.params.some((param) => param.required) && (
                        <FieldNote>{S.required}</FieldNote>
                      )}
                    </>
                  ),
                },
              ]
            : []),
          ...(connector.kind === "file"
            ? [
                {
                  key: "extensions",
                  label: S.extensions,
                  value: (connector.extensions ?? []).join(", ") || "-",
                },
              ]
            : []),
          ...(fetch && connector.historyDays != null
            ? [
                {
                  key: "history",
                  label: S.history,
                  value: S.firstFetch(connector.historyDays),
                },
              ]
            : []),
          {
            key: "checksum",
            label: S.checksum,
            value: (
              <>
                <code className={code} title={connector.contentSha256}>
                  {shortSha(connector.contentSha256)}
                </code>
                <Button
                  variant="link"
                  size="lg"
                  onPress={() => void state.onWorkspaceCopied(connector.contentSha256)}
                >
                  {S.copy}
                </Button>
              </>
            ),
          },
          { key: "disk", label: S.diskWrite, value: S.tmpOnly },
        ]}
      />
      <FieldNote className="mt-2 block">{S.sandbox}</FieldNote>
      <Kicker title={S.details} />
      <KeyValues
        keyWidth="narrow"
        baseline
        rows={[
          { key: "id", label: S.id, value: <code className={code}>{connector.id}</code> },
          { key: "version", label: S.version, value: connector.version ?? "-" },
          { key: "author", label: S.author, value: connector.author ?? "-" },
          { key: "description", label: S.description, value: connector.description ?? "-" },
          { key: "module", label: S.module, value: moduleLabel(connector.module) },
          { key: "kind", label: S.kind, value: kindLabel(connector.kind) },
          {
            key: "approved",
            label: S.approvedAt,
            value: connector.approvedAt ? when(connector.approvedAt) : "-",
          },
        ]}
      />
      {fetch && <BindingsPanelView connector={connector} state={state} />}
      <Runs
        runs={runsOf(state.connectorActivity.runs, connector.id)}
        fetch={fetch}
        timeoutS={connector.timeoutS}
      />
      <div className="mt-2.5 text-xs-plus text-fg-muted">{S.foot}</div>
    </Drawer>
  );
}

/** The connector's recorded runs in this profile (old `Runs`); a failed run opens its RunError with the stderr tail. */
function Runs({
  runs,
  fetch,
  timeoutS,
}: {
  runs: readonly ConnectorRun[];
  fetch: boolean;
  timeoutS: number | undefined;
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const cols = fetch ? 5 : 4;
  const toggle = (id: number) =>
    setOpen((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <Kicker title={S.runs}>
        <Tag>{S.lastN(runs.length)}</Tag>
      </Kicker>
      <div className={scrollCls()}>
        <table className={dataTableCls}>
          <thead>
            <tr>
              <th className={dataThCls()}>{S.colWhen}</th>
              <th className={dataThCls()}>{S.colCommand}</th>
              <th className={dataThCls()}>{S.colResult}</th>
              <th className={dataThCls(true)}>{S.colRecords}</th>
              {fetch && <th className={dataThCls(true)}>{S.colDenied}</th>}
            </tr>
          </thead>
          <tbody>
            {runs.flatMap((run) => {
              const details = !!run.errorKind || (!!run.stderrTail && run.outcome !== "ok");
              const rows = [
                <tr key={run.id}>
                  <td className={`${dataTdCls()} whitespace-nowrap`}>
                    {when(run.startedAt)}
                    <FieldNote> · {durationText(run.durationMs)}</FieldNote>
                  </td>
                  <td className={dataTdCls()}>
                    <code className={code}>{run.command}</code>
                  </td>
                  <td className={dataTdCls()}>
                    <Tag tone={tagTone(outcomeTone(run.outcome))}>{outcomeLabel(run.outcome)}</Tag>
                    {run.errorKind && <FieldNote> {kindShort(run.errorKind)}</FieldNote>}
                    {details && (
                      <>
                        {" · "}
                        <Button
                          variant="link"
                          size="sm"
                          expanded={open.has(run.id)}
                          onPress={() => toggle(run.id)}
                        >
                          {C.details}
                        </Button>
                      </>
                    )}
                  </td>
                  <td className={dataTdCls(true)}>
                    {run.records ? run.records : run.outcome === "ok" ? run.records : "-"}
                  </td>
                  {fetch && (
                    <td className={dataTdCls(true)}>
                      {run.deniedHosts.length ? (
                        <span title={run.deniedHosts.join(", ")} className="text-warning">
                          {run.deniedHosts.length}
                        </span>
                      ) : (
                        <span className="text-fg-muted">-</span>
                      )}
                    </td>
                  )}
                </tr>,
              ];
              if (open.has(run.id))
                rows.push(
                  <tr key={`${run.id}-d`}>
                    <td colSpan={cols} className={dataTdCls()}>
                      <RunError
                        title={kindLine(run.errorKind ?? "internal", timeoutS)}
                        details={run.stderrTail ?? undefined}
                        open
                        className="my-1"
                      />
                    </td>
                  </tr>,
                );
              return rows;
            })}
            {!runs.length && (
              <tr>
                <td colSpan={cols} className={`${dataTdCls()} text-fg-muted`}>
                  {S.neverRun}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-2.5 text-xs-plus text-fg-muted">{S.runsFoot}</div>
    </>
  );
}
