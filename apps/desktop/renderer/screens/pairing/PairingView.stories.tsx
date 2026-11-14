import { PairingView, type PairingViewState } from "./PairingView.js";

const noop = async () => {};
const invited: PairingViewState = {
  kind: "invited",
  qr: "cashu-pair:synthetic-invitation-0123456789abcdef",
  codePreview: "cashu-pair:synthet…89abcdef",
  expiresAt: new Date(2026, 10, 14, 18, 56).getTime(),
  phone: "connected",
  code: "",
  onCodeChange: noop,
  onConfirm: noop,
  onCancel: noop,
  onCopy: noop,
  canCopy: true,
  copied: false,
  submitting: false,
};

export default { title: "Desktop/Settings/Pairing", component: PairingView };
export const Idle = { render: () => <PairingView state={{ kind: "idle", onCreate: noop }} /> };
export const Invitation = { render: () => <PairingView state={invited} /> };
/** No phone has connected yet: no six-digit field, no "Confirm code". */
export const InvitationWaitingForScan = {
  render: () => <PairingView state={{ ...invited, phone: "waiting" }} />,
};
/** A host that does not say whether a phone connected: the six-digit field as before. */
export const InvitationPhoneUnknown = {
  render: () => <PairingView state={{ ...invited, phone: "unknown" }} />,
};
export const InvitationCopied = {
  render: () => <PairingView state={{ ...invited, copied: true }} />,
};
export const Checking = {
  render: () => <PairingView state={{ kind: "checking", onCancel: noop }} />,
};
export const Unknown = {
  render: () => <PairingView state={{ kind: "unknown", onInspect: noop }} />,
};
export const Completed = {
  render: () => <PairingView state={{ kind: "completed", onCreate: noop }} />,
};
export const Refused = {
  render: () => <PairingView state={{ kind: "refused", onCreate: noop }} />,
};
/** A cancel that came after the host had written the phone into the vault. */
export const AlreadyAdded = {
  render: () => <PairingView state={{ kind: "already_added", onCreate: noop }} />,
};
export const Unavailable = { render: () => <PairingView state={{ kind: "unavailable" }} /> };
export const Expired = {
  render: () => <PairingView state={{ kind: "expired", onCreate: noop }} />,
};
export const SyncOff = {
  render: () => <PairingView state={{ kind: "sync_off", onCreate: noop }} onGoToSync={() => {}} />,
};
export const WaitingForPhone = { render: () => <PairingView state={{ kind: "waiting" }} /> };
