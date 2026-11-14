// Stories of the sync slot (CSF 3, synthetic profile name): the quiet paused line, a stuck-writer warning,
// the sync-off notice (#25.4) with "Keep for now", the removed notice (#23.7) after a failed "Remove this
// copy", and an empty slot.
import { SyncSlotView } from "./SyncSlotView";
import type { SyncSlot } from "./useSyncNotice";

const noop = () => {};
const empty: SyncSlot = { line: null, notice: null };

const meta = { title: "Mobile/Sync/SyncSlot", component: SyncSlotView, args: { slot: empty } };
export default meta;

export const Empty = { args: { slot: empty } };
export const Paused = {
  args: {
    slot: {
      line: { text: "Sync paused since 19:50 · cashU works as usual", tone: "muted" },
      notice: null,
    } satisfies SyncSlot,
  },
};
export const StuckFailed = {
  args: {
    slot: {
      line: {
        text: "Changes from Demo Mac can't be read. Check Devices on your Mac.",
        tone: "warning",
      },
      notice: null,
    } satisfies SyncSlot,
  },
};
export const TurnedOff = {
  args: {
    slot: {
      line: null,
      notice: {
        kind: "syncOff",
        title:
          "Sync for Anna was turned off on your Mac. The copy on this phone stays until you remove it.",
        body: null,
        actions: [
          { label: "Remove this copy", tone: "danger", onPress: noop },
          { label: "Keep for now", tone: "secondary", onPress: noop },
        ],
        failed: false,
      },
    } satisfies SyncSlot,
  },
};
export const RemovedRemoveFailed = {
  args: {
    slot: {
      line: null,
      notice: {
        kind: "removed",
        title: "This phone was removed from Anna on your Mac",
        body: "The copy stays on this phone until you remove it.",
        actions: [{ label: "Remove this copy", tone: "danger", onPress: noop }],
        failed: true,
      },
    } satisfies SyncSlot,
  },
};
