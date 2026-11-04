import { Button, Card, DateText, VirtualList } from "@cashu/ui";
import type { ReactNode } from "react";
import { AlertHistoryView } from "./AlertHistoryView.js";
import {
  ALERT_STATUS_FILTERS,
  type AlertLine,
  type AlertSourceFilter,
  type AlertStatusFilter,
} from "./alertModels.js";
import { filterSelect } from "./controls.js";
import { alertBadgeTone, scopeLabel, statusLabel, toneLabel } from "./labels.js";
import { G } from "./Signals.strings.js";
import { Count, SignalValue } from "./SignalValue.js";
import type { AlertsPageState } from "./useAlertsPage.js";

const badge = {
  positive: "bg-positive-bg text-positive",
  info: "bg-info-bg text-accent",
  muted: "bg-surface-sunken text-fg-muted",
} as const;
const chip = "rounded-sm border border-border px-1.5 py-0.5 text-xs";

type Props = Pick<
  AlertsPageState,
  | "status"
  | "source"
  | "rows"
  | "counts"
  | "history"
  | "canRestore"
  | "canExport"
  | "onStatus"
  | "onSource"
  | "onEdit"
  | "onRemove"
  | "onRestore"
  | "onToggleMute"
  | "onExport"
> & {
  /** The alert editor, shown above the list while open. */
  editor?: ReactNode;
};

/** The Alerts page: filters, the editor slot, the alert list with counts and the triggered history. */
export function AlertsPageView(props: Props) {
  const { rows, counts } = props;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <select
          value={props.status}
          onChange={(event) => props.onStatus(event.target.value as AlertStatusFilter)}
          aria-label={G.status}
          className={filterSelect}
        >
          {ALERT_STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? G.all : statusLabel(value)}
            </option>
          ))}
        </select>
        <select
          value={props.source}
          onChange={(event) => props.onSource(event.target.value as AlertSourceFilter)}
          aria-label={G.source}
          className={filterSelect}
        >
          <option value="all">{G.all}</option>
          <option value="user">{G.you}</option>
          <option value="agent">{G.agent}</option>
        </select>
        <Button onPress={() => props.onEdit("new")}>{G.alertsNew}</Button>
        {props.canRestore && <Button onPress={() => void props.onRestore()}>{G.restore}</Button>}
      </div>
      {props.editor}
      <Card>
        <h2>{G.alerts}</h2>
        {counts && (
          <div className="flex flex-wrap gap-3 py-2 text-sm">
            <span>
              {G.active}: <Count value={counts.active} />
            </span>
            <span>
              {G.triggered}: <Count value={counts.triggered} />
            </span>
            <span>
              {G.snoozed}: <Count value={counts.snoozed} />
            </span>
            <span>
              {G.agentLive}: <Count value={counts.agentLive} />
            </span>
          </div>
        )}
        {rows.length === 0 ? (
          <p>{G.noRows}</p>
        ) : (
          <VirtualList
            items={rows}
            getKey={(row) => row.gid}
            label={G.alerts}
            estimateSize={92}
            rowClassName="border-b border-border p-2"
            renderItem={(row) => <AlertLineView {...props} row={row} />}
          />
        )}
      </Card>
      <AlertHistoryView
        rows={props.history}
        canExport={props.canExport}
        onExport={props.onExport}
      />
    </>
  );
}

function AlertLineView({ row, onEdit, onToggleMute, onRemove }: Props & { row: AlertLine }) {
  return (
    <>
      <div className="flex flex-wrap justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <strong>{row.title}</strong>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${badge[alertBadgeTone(row.status)]}`}
            >
              {row.tag}
            </span>
            <span className={chip}>{statusLabel(row.status)}</span>
            {row.fromAgent && <span className={chip}>{G.agent}</span>}
          </div>
          <p>
            {row.condition} · {row.symbol ?? scopeLabel(row.scope)}
          </p>
          <p>
            {G.polarity}: {toneLabel(row.polarity)} · {G.severity}: {statusLabel(row.severity)}
          </p>
          {(row.level || row.distance !== null) && (
            <p>
              {row.level && (
                <>
                  {G.alertLevel}: {row.level}
                </>
              )}{" "}
              {row.distance !== null && (
                <>
                  {G.alertDistance}: {row.distance}
                </>
              )}
            </p>
          )}
          <p>
            {G.current}: <SignalValue value={row.current} /> · {G.status}:{" "}
            {statusLabel(row.signalStatus)}
          </p>
          {row.stateUnavailable && <p>{G.unavailable}</p>}
        </div>
        <div className="flex gap-2">
          <Button onPress={() => onEdit(row.gid)}>{G.alertsEdit}</Button>
          <Button onPress={() => void onToggleMute(row.gid, row.status)}>
            {row.muted ? G.unmute : G.mute}
          </Button>
          <Button onPress={() => void onRemove(row.gid)}>{G.remove}</Button>
        </div>
      </div>
      <DateText value={row.checkedDay} />
    </>
  );
}
