// Stories of the pairing modal (CSF 3, synthetic names and digits): every state of the flow, the camera
// denied (paste as the way in), a pasted text that is not a code, the discard question, the six digits,
// receiving, whose phone, the first sync before and after the profile arrived, and each way it stops.
import { PairView, type PairViewProps } from "./PairView";

const noop = () => {};
const scan: PairViewProps = {
  kind: "scan",
  input: "camera",
  camera: "granted",
  name: "iPhone 16 Pro",
  notACode: false,
  pasted: "",
  onScanned: noop,
  onPastedChanged: noop,
  onPasteSubmitted: noop,
  onUsePaste: noop,
  onUseCamera: noop,
  onNameChanged: noop,
  onShown: noop,
  onCancel: noop,
};

const meta = { title: "Mobile/Pair/Pair", component: PairView, args: scan };
export default meta;

export const Scan = { args: {} };
export const CameraDenied = { args: { input: "paste", camera: "denied" } };
export const Paste = { args: { input: "paste", pasted: "cashu-pair:{...}" } };
/** A long pasted code: shown from its first character, the field grows with it. */
export const PasteLong = {
  args: {
    input: "paste",
    pasted: `cashu-pair:{"eph":"${"0a".repeat(32)}","vault":"${"1b".repeat(32)}"}`,
  },
};
export const NotACode = { args: { input: "paste", pasted: "hello", notACode: true } };
export const Discard = {
  args: { kind: "discard", profile: "Ala", onDiscard: noop, onCancel: noop },
};
export const Connecting = { args: { kind: "connecting", onCancel: noop } };
export const Code = {
  args: { kind: "code", sas: "418207", name: "iPhone 16 Pro", secondsLeft: 102, onCancel: noop },
};
export const Receiving = { args: { kind: "receiving", parts: 3, onCancel: noop } };
export const Storing = { args: { kind: "storing" } };
export const Role = {
  args: { kind: "role", role: "owner", onRolePicked: noop, onContinue: noop },
};
export const RolePartner = {
  args: { kind: "role", role: "partner", onRolePicked: noop, onContinue: noop },
};
export const FirstSyncWaiting = {
  args: {
    kind: "firstSync",
    profile: null,
    progress: null,
    canOpen: false,
    suggestLock: true,
    done: false,
    onOpen: noop,
  },
};
export const FirstSyncProgress = {
  args: {
    kind: "firstSync",
    profile: null,
    progress: { applied: 12_400, expected: 64_000 },
    canOpen: false,
    suggestLock: true,
    done: false,
    onOpen: noop,
  },
};
export const FirstSyncOpenable = {
  args: {
    kind: "firstSync",
    profile: "Ala",
    progress: { applied: 40_000, expected: 64_000 },
    canOpen: true,
    suggestLock: true,
    done: false,
    onOpen: noop,
  },
};
export const Done = {
  args: {
    kind: "firstSync",
    profile: "Ala",
    progress: null,
    canOpen: true,
    suggestLock: true,
    done: true,
    onOpen: noop,
  },
};
/** Done with the app lock on after the flow (the default of a paired phone): no "Turn on Face ID". */
export const DoneLockOn = { args: { ...Done.args, suggestLock: false } };
const failed = (reason: string, canScanAgain = true) => ({
  args: { kind: "failed", reason, canScanAgain, onScanAgain: noop, onCancel: noop },
});
export const Expired = failed("expired");
export const Taken = failed("taken");
export const OtherProject = failed("other_project", false);
export const Offline = failed("offline");
export const NoSync = failed("no_sync", false);
export const Refused = failed("refused");
export const Failed = failed("failed");
