// Cells of the Aktywa / Obserwowane tables with hover state (ab24ab6): the instrument label of a row (`.w td > .il`
// with RowMarks, the agent badge, the classify icon and the InstCard hover card, its strategy notes included) and the
// value over Wynik % cell (Portfolio.tsx GainCell, `.ilc.gain`). Pure apart from the hover state; texts come from
// assetListModel.ts.
import {
  AgentTag,
  CardRows,
  ClassifyButton,
  HoverCard,
  InstCardBody,
  InstLabel,
  RowMarks,
  toneCls,
  useHoverCard,
  useTouch,
} from "@cashu/ui";
import { useId } from "react";
import type { GainCellProps, RowLabel } from "./assetListModel.js";

/** The row's instrument label (a flex row of at least 31px) with its hover card. */
export function RowLabelCell({ label, onOpen }: { label: RowLabel; onOpen(): void }) {
  const id = useId();
  const touch = useTouch();
  const hover = useHoverCard(!touch);
  return (
    <span
      className="flex min-h-7.75 min-w-0"
      title={touch ? label.touchTitle : undefined}
      {...hover.handlers}
    >
      <InstLabel
        {...label.tile}
        name={label.name}
        onOpen={onOpen}
        sub={label.sub}
        badges={
          <>
            <RowMarks {...label.marks} />
            {label.agent != null && <AgentTag text={label.agent} />}
          </>
        }
        action={label.classify && <ClassifyButton {...label.classify} />}
      />
      {hover.anchor && (
        <HoverCard anchor={hover.anchor} id={id}>
          <InstCardBody {...label.card} />
        </HoverCard>
      )}
    </span>
  );
}

/** `Wynik %` under the value (design V5 `value · return`): the value over the signed percentage; hovering the
 * percentage opens the gain card (gain / loss in money, the cost). `className`: the cell's padding / borders. */
export function GainCell({
  value,
  text,
  tone,
  rows,
  touchTitle,
  className = "",
}: GainCellProps & { value: string; className?: string }) {
  const id = useId();
  const touch = useTouch();
  const hover = useHoverCard(rows != null && !touch);
  return (
    <td className={`text-right tabular-nums whitespace-nowrap ${className}`}>
      <span className="inline-grid justify-items-end gap-px">
        <b className="font-strong text-sm-plus text-fg">{value}</b>
        <span
          className={`text-xs-plus ${tone ? toneCls[tone] : "text-fg-muted"}`}
          title={touch ? touchTitle : undefined}
          aria-describedby={hover.anchor ? id : undefined}
          {...hover.handlers}
        >
          {text}
          {hover.anchor && rows && (
            <HoverCard anchor={hover.anchor} id={id} gain>
              <CardRows rows={rows} alignEnd />
            </HoverCard>
          )}
        </span>
      </span>
    </td>
  );
}
