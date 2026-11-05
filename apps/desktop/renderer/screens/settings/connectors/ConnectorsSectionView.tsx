// Ustawienia › Konektory (ab24ab6 core/ConnectorsSection.tsx): every installed connector, what waits for the
// owner's approval first; the row's button opens the connector drawer. Native: install from a folder, the list
// refresh, the banking panel at the end of the card. Pure view (the open drawer is view state).
import { S as CS } from "@cashu/i18n/core/ConnectorsSection.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { CS as LINE } from "@cashu/i18n/core/connectors.strings";
import { Button, Notice, SectionCard, SettingRow, Skeleton, Tag } from "@cashu/ui";
import { type ReactNode, useState } from "react";
import { T } from "../Settings.strings.js";
import type { SettingsScreenState } from "../useSettingsScreen.js";
import { ConnectorDrawerView, StatusTag } from "./ConnectorDrawerView.js";
import { type Connector, kindLabel, moduleLabel, sortConnectors } from "./connectorsModel.js";

const code = "font-mono text-code-ui [font-variant-ligatures:none]";

export function ConnectorsSectionView({
  state,
  bankingPanel,
}: {
  state: SettingsScreenState;
  bankingPanel?: ReactNode;
}) {
  const snapshot = state.connectorSnapshot;
  const busy = state.connectorBusy;
  const [open, setOpen] = useState<string | null>(null);
  const connectors = snapshot ? sortConnectors(snapshot.connectors) : [];
  const waiting = connectors.filter(
    (c) => c.approval === "pending" || c.approval === "changed",
  ).length;
  const opened = connectors.find((c) => c.id === open) ?? null;
  const actions = (
    <>
      <Button disabled={busy} onPress={() => void state.installConnector()}>
        {T.connectorInstall}
      </Button>
      <Button disabled={busy} onPress={() => void state.refreshConnectors()}>
        {C.refresh}
      </Button>
    </>
  );
  const bindings = (connector: Connector) =>
    snapshot?.bindings.filter((b) => b.connector_id === connector.id).length ?? 0;
  return (
    <SectionCard id="set-connectors" title={CS.title} className="scroll-mt-16">
      {snapshot && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          {connectors.length > 0 && <Tag>{CS.count(connectors.length)}</Tag>}
          {waiting > 0 && (
            <Tag tone="warning" solid>
              {CS.toApprove(waiting)}
            </Tag>
          )}
          <span className="flex-1" />
          {actions}
        </div>
      )}
      {!snapshot &&
        (busy ? (
          [0, 1, 2].map((k) => <Skeleton key={k} height={40} className="my-1.5" />)
        ) : (
          <Notice tone="negative" role="alert" action={actions}>
            {T.connectorUnavailable}
          </Notice>
        ))}
      {snapshot && connectors.length === 0 && (
        <div className="py-2 text-md text-fg-muted">
          <div className="font-strong text-fg">{CS.emptyTitle}</div>
          <div className="mt-1 text-sm">
            {CS.emptyBefore}
            <code className={code}>/import-builder</code>
            {CS.emptyAfter}
          </div>
        </div>
      )}
      {connectors.map((connector) => (
        <SettingRow
          key={`${state.connectorVault}:${connector.id}`}
          title={
            <>
              {connector.name}
              <Tag>{moduleLabel(connector.module)}</Tag>
              <Tag>{kindLabel(connector.kind)}</Tag>
              <StatusTag status={connector.approval} />
            </>
          }
          detail={connector.kind === "fetch" ? LINE.bindings(bindings(connector)) : undefined}
          action={
            connector.approval === "pending" ? (
              <Button variant="primary" onPress={() => setOpen(connector.id)}>
                {CS.review}
              </Button>
            ) : connector.approval === "changed" ? (
              <Button variant="primary" onPress={() => setOpen(connector.id)}>
                {CS.checkChanges}
              </Button>
            ) : (
              <Button onPress={() => setOpen(connector.id)}>{C.details}</Button>
            )
          }
        />
      ))}
      <div className="mt-2.5 text-xs-plus text-fg-muted">{CS.foot}</div>
      {bankingPanel}
      {opened && (
        <ConnectorDrawerView
          key={`${state.connectorVault}:${opened.id}`}
          connector={opened}
          state={state}
          onClose={() => setOpen(null)}
        />
      )}
    </SectionCard>
  );
}
