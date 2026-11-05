// One installed connector (ab24ab6 core/ConnectorDrawer.tsx): the state notices, what the owner approves first
// (interpreter, secrets, parameters, checksum), the quiet facts, the profile's fetch bindings, then approve / turn
// off / delete in the foot. Approve sends the digest and interpreter this drawer shows. The native snapshot has no
// command, hosts, time limit, files or runs: those blocks are left out. Pure view (confirm step = view state).

import { S } from "@cashu/i18n/core/ConnectorDrawer.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { STATUS } from "@cashu/i18n/core/connectors.strings";
import { Button, Drawer, FieldNote, KeyValues, Kicker, Notice, Tag } from "@cashu/ui";
import { useState } from "react";
import { T } from "../Settings.strings.js";
import { tagTone } from "../settingsModel.js";
import type { SettingsScreenState } from "../useSettingsScreen.js";
import { BindingsPanelView } from "./BindingsPanelView.js";
import { type Connector, kindLabel, moduleLabel, shortSha } from "./connectorsModel.js";

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
  const approve = () => {
    if (!interpreter) return;
    // the values this drawer showed, never re-read before sending
    void state.onConnectorAction({
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
        onPress={() =>
          void state.onConnectorAction({ op: "remove", id: connector.id, allVaults: true })
        }
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
          onPress={() => void state.onConnectorAction({ op: "disable", id: connector.id })}
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
            key: "interpreter",
            label: T.connectorInterpreter,
            value: <code className={`${code} font-strong`}>{interpreter ?? "-"}</code>,
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
        ]}
      />
      <Kicker title={S.details} />
      <KeyValues
        keyWidth="narrow"
        baseline
        rows={[
          { key: "id", label: S.id, value: <code className={code}>{connector.id}</code> },
          { key: "module", label: S.module, value: moduleLabel(connector.module) },
          { key: "kind", label: S.kind, value: kindLabel(connector.kind) },
        ]}
      />
      {fetch && <BindingsPanelView connector={connector} state={state} />}
      <div className="mt-2.5 text-xs-plus text-fg-muted">{S.foot}</div>
    </Drawer>
  );
}
