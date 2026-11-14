// The ported alert row (ab24ab6 v2/Alerts.tsx AlertRow; index.css `.al`, `.ai`, `.dist .bar`): the state icon and
// title (+ agent badge), the condition line, the distance to the level with its bar or the status, the remove
// button. Used by the asset page (compact) and the Home's alert lists. Pure: props from alertsModel.alertRowProps.
import { S as W } from "@cashu/i18n/core/widgets.strings";
import { AgentTag, AlertIcon, AlertStatus } from "@cashu/ui";
import { Fragment } from "react";
import type { AlertRowProps } from "./alertsModel.js";

export type { AlertRowProps };

export function AlertRow(p: AlertRowProps) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 border-b border-border py-2 last:border-b-0">
      <div>
        <div className="flex flex-wrap items-center gap-1.5 text-sm font-strong">
          <span className="min-w-0">
            {p.icon && <AlertIcon state={p.icon.state} title={p.icon.title} className="mr-1.5" />}
            {p.cond}
          </span>
          {p.agent && <AgentTag full text="agent" title={W.addedByAgent} />}
        </div>
        <div className="text-xs text-fg-muted">
          {p.line.map((part) =>
            part.bold ? (
              <b key={part.key} className="font-strong text-fg tabular-nums">
                {part.text}
              </b>
            ) : (
              <Fragment key={part.key}>{part.text}</Fragment>
            ),
          )}
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.75 text-right">
        {p.status && <AlertStatus status={p.status} />}
        {p.dist && (
          <span className="whitespace-nowrap text-xs tabular-nums">
            {p.dist.text}
            <span
              aria-hidden="true"
              className="relative ml-1.5 inline-block h-1 w-11.5 overflow-hidden rounded-4xs bg-chip align-middle"
            >
              <i
                className={`absolute inset-y-0 left-0 rounded-4xs ${p.trig ? "bg-negative" : "bg-fg-muted"}`}
                style={{ width: `${p.dist.fill}%` }}
              />
            </span>
          </span>
        )}
        {p.remove && (
          <button
            type="button"
            title={p.remove.title}
            aria-label={p.remove.label}
            onClick={p.remove.onPress}
            className="cursor-pointer border-0 bg-transparent px-1.5 py-0.5 font-control text-base leading-control text-fg-muted hover:text-negative"
          >
            {"✕"}
          </button>
        )}
      </div>
    </div>
  );
}
