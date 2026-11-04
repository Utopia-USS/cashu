import { Button, DateText, Modal, VirtualList } from "@cashu/ui";
import { useEffect, useRef } from "react";
import { polarityGlyph, toneLabel } from "./labels.js";
import type { SignalsNotice } from "./outcomes.js";
import type { SignalGroup } from "./presentation.js";
import { G } from "./Signals.strings.js";
import { SignalsNoticeView } from "./SignalsNoticeView.js";
import { Count } from "./SignalValue.js";
import {
  type GroupListRow,
  type GroupSection,
  groupLabel,
  type SignalLine,
} from "./signalModels.js";
import type { SignalsListState } from "./useSignalsScreen.js";

type Props = Omit<SignalsListState, "open"> & {
  notice: SignalsNotice | null;
  refusal: string | null;
};

/** The full Signals dialog: portfolio and watched groups with keyboard navigation (j / k / Enter). */
export function SignalsListView(props: Props) {
  const { cursor, filter, onFilter, onClose } = props;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (cursor === null) return;
    panel.current
      ?.querySelector<HTMLElement>(`[data-signal="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  return (
    <Modal
      label={G.signals}
      onClose={onClose}
      panelRef={panel}
      focus="panel"
      onKeyDown={(event) => {
        if (props.deciding) return;
        if (event.key === "Escape") onClose();
        if (event.key === "j" || event.key === "ArrowDown") {
          event.preventDefault();
          props.onMove(1);
        }
        if (event.key === "k" || event.key === "ArrowUp") {
          event.preventDefault();
          props.onMove(-1);
        }
        if (event.key === "Enter" && cursor) props.onDecideCursor();
      }}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2>{G.signals}</h2>
        <Button pressed={filter === "all"} onPress={() => onFilter("all")}>
          {G.all}
        </Button>
        <Button pressed={filter === "positive"} onPress={() => onFilter("positive")}>
          {G.chances}
        </Button>
        <Button pressed={filter === "negative"} onPress={() => onFilter("negative")}>
          {G.risks}
        </Button>
        <span className="flex-1" />
        <Button onPress={onClose}>{G.close}</Button>
      </header>
      <SignalsNoticeView notice={props.notice} refusal={props.refusal} />
      {!props.available ? (
        <p>{G.unavailable}</p>
      ) : props.empty ? (
        <p>{G.empty}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <GroupList {...props} label={G.portfolio} section={props.portfolio} />
          <GroupList {...props} label={G.watched} section={props.watched} />
        </div>
      )}
      <footer className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button onPress={() => props.onOpenPage("watchlist")}>{G.watchlist}</Button>
        <Button onPress={() => props.onOpenPage("journal")}>{G.journal}</Button>
      </footer>
    </Modal>
  );
}

function GroupList({ label, section, ...props }: Props & { label: string; section: GroupSection }) {
  return (
    <section className="min-w-0">
      <h3 className="sticky top-0 z-10 bg-surface p-2">
        {label} <Count value={section.signals} />
      </h3>
      <VirtualList
        items={section.rows}
        getKey={(row) => row.key}
        label={label}
        estimateSize={74}
        rowClassName="border-b border-border p-2"
        renderItem={(row: GroupListRow) =>
          row.kind === "group" ? (
            <GroupHeader {...props} group={row.group} />
          ) : (
            <SignalLineView {...props} line={row.signal} />
          )
        }
      />
    </section>
  );
}

function GroupHeader({ group, busy, onDecide, onAcknowledge }: Props & { group: SignalGroup }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <strong>{groupLabel(group)}</strong>
      <span>{group.settled ? G.settled : toneLabel(group.state)}</span>
      {!group.settled && (
        <>
          <Button disabled={busy} onPress={() => onDecide(group.key)}>
            {G.decide}
          </Button>
          <Button disabled={busy} onPress={() => onAcknowledge(group.key)}>
            {G.acknowledge}
          </Button>
        </>
      )}
    </div>
  );
}

function SignalLineView({ line, ...props }: Props & { line: SignalLine }) {
  const { deferUntil, lastDecision, instrument, note } = line;
  return (
    <div
      className="grid gap-1"
      data-signal={line.gid}
      tabIndex={-1}
      aria-current={props.cursor === line.gid ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden>{polarityGlyph(line.polarity)}</span>
        <span>{line.message}</span>
        <DateText value={line.day} />
        <span className={line.current ? "text-fg-muted" : "text-warning"}>
          {line.current ? G.current : G.unconfirmed}
        </span>
        {line.snoozed && <span>{G.snoozed}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {instrument !== null && (
          <Button onPress={() => props.onOpenAsset(instrument)}>{G.opens}</Button>
        )}
        {note && props.canOpenNote && (
          <Button onPress={() => props.onOpenNote(note, instrument, line.segment)}>{G.note}</Button>
        )}
        {deferUntil && (
          <Button disabled={props.busy} onPress={() => props.onDefer(line.gid, deferUntil)}>
            {G.nextDeposit}
          </Button>
        )}
        {line.snoozed && (
          <Button disabled={props.busy} onPress={() => props.onUndoDefer(line.gid)}>
            {G.undo}
          </Button>
        )}
        {lastDecision && (
          <Button disabled={props.busy} onPress={() => props.onUndoDecision(lastDecision)}>
            {G.undo}
          </Button>
        )}
      </div>
    </div>
  );
}
