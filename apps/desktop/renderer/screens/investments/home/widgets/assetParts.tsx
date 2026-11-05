// Cells of the Aktywa / Obserwowane tables with hover state (ab24ab6): the instrument label of a row (`.w td > .il`
// with RowMarks, the agent badge, the classify icon and the InstCard hover card) and the Wynik % cell (Portfolio.tsx
// GainCell, `.ilc.gain`). Pure apart from the hover state; texts come from assetListModel.ts.
import { InstLabel } from "@cashu/ui";
import { useId } from "react";
import type { GainCellProps, RowLabel } from "./assetListModel.js";
import { CardRows, HoverCard, InstCardBody, useHoverCard, useTouch } from "./HoverCard.js";
import { AgentTag, ClassifyButton, RowMarks } from "./marks.js";
import { tdCls, toneCls } from "./table.js";

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

/** `Wynik %`: the signed percentage; hovering opens the gain card (gain / loss in money, the cost). */
export function GainCell({ text, tone, rows, touchTitle }: GainCellProps) {
  const id = useId();
  const touch = useTouch();
  const hover = useHoverCard(rows != null && !touch);
  return (
    <td
      className={`${tdCls(true)} ${tone ? toneCls[tone] : ""}`}
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
    </td>
  );
}
