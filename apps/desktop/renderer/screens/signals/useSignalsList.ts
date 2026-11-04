import {
  conditionalOwnerAcknowledge,
  type ReadySignals,
  saveSignalGroup,
  signalsSnooze,
} from "@cashu/store/investments/signals-screen";
import { isStale, useCommand, type useConnection, useUiAction } from "@cashu/store-react";
import { useEffect, useRef, useState } from "react";
import type { useDurableCommands } from "../useDurableCommand.js";
import { notificationSignalGroup } from "./notificationFocus.js";
import { type SignalFilter, type SignalGroup, signalGroups } from "./presentation.js";
import { groupOfSignal, movedCursor, snoozeInstant } from "./signalModels.js";
import type { SignalsFeedbackApi } from "./useSignalsFeedback.js";

/** The full Signals dialog: open state, polarity filter, keyboard cursor and per-signal actions. */
export function useSignalsList(args: {
  readonly data: ReadySignals | null;
  readonly privacy: boolean;
  readonly connection: ReturnType<typeof useConnection>;
  readonly initialSignal: string | null | undefined;
  readonly feedback: SignalsFeedbackApi;
  readonly durable: ReturnType<typeof useDurableCommands>;
}) {
  const { data, privacy, connection, feedback, durable } = args;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<SignalFilter>("all");
  const [cursor, setCursor] = useState<string | null>(args.initialSignal ?? null);
  /** The group whose decision dialog is open. */
  const [deciding, setDeciding] = useState<string | null>(null);
  const acknowledge = useCommand(conditionalOwnerAcknowledge);
  const snoozeAction = useUiAction(signalsSnooze);
  const groups: readonly SignalGroup[] =
    data === null ? [] : signalGroups(data.open, data.held, filter);
  const selected = groups.find((group) => group.key === deciding) ?? null;

  // A notification names one signal: open its group once the snapshot can show it.
  const focusedSignal = useRef<string | null>(null);
  useEffect(() => {
    const signal = args.initialSignal;
    if (signal === undefined || signal === null) {
      focusedSignal.current = null;
      return;
    }
    if (data === null || privacy || isStale(connection)) return;
    if (focusedSignal.current === signal) return;
    focusedSignal.current = signal;
    const group = notificationSignalGroup(data, signal);
    setFilter("all");
    setCursor(group === null ? null : signal);
    setDeciding(group);
  }, [args.initialSignal, data, privacy, connection]);

  const acknowledgeGroup = (key: string) => {
    const group = groups.find((row) => row.key === key);
    if (!group) return;
    void feedback.exclusive("acknowledge", async () => {
      const outcome = await saveSignalGroup(
        group.live.map(
          (row) => () =>
            durable.run(`ack:${row.gid}`, acknowledge, { signal: row.gid, reason: null }),
        ),
        feedback.isActive,
      );
      if (feedback.isActive()) feedback.grouped(outcome);
    });
  };
  const snooze = (signal: string, until: string | null) => {
    if (privacy) return;
    void feedback.exclusive("snooze", async () => {
      const result = await snoozeAction.run({ signal, until });
      if (result.status === "completed")
        feedback.setNotice(result.value.status === "saved" ? "saved" : "cleanup");
      else if (result.status === "outcome_unknown") feedback.setNotice("unknown");
      else {
        feedback.setRefusal(result.reason);
        feedback.setNotice("failed");
      }
    });
  };
  return {
    open,
    filter,
    cursor,
    groups,
    selected,
    setOpen,
    setDeciding,
    setCursor,
    onFilter: setFilter,
    onMove: (delta: number) => setCursor(movedCursor(groups, cursor, delta)),
    /** Enter on the cursor opens the decision dialog of the cursor's group. */
    onDecideCursor: () => {
      const group = cursor === null ? null : groupOfSignal(groups, cursor);
      if (group !== null) setDeciding(group);
    },
    onAcknowledge: acknowledgeGroup,
    onDefer: (signal: string, day: string) => snooze(signal, snoozeInstant(day)),
    onUndoDefer: (signal: string) => snooze(signal, null),
  };
}
