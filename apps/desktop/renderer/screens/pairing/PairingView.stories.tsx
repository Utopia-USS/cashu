import { PairingView, type PairingViewState } from "./PairingView.js";

const noop = async () => {};
const invited: PairingViewState = {
  kind: "invited",
  qr: "cashu-pair:synthetic-invitation-0123456789abcdef",
  expiresAt: "12:00",
  code: "",
  onCodeChange: noop,
  onConfirm: noop,
  onCancel: noop,
  onCopy: noop,
  canCopy: true,
  submitting: false,
};

export default { title: "Desktop/Settings/Pairing", component: PairingView };
export const Idle = { render: () => <PairingView state={{ kind: "idle", onCreate: noop }} /> };
export const Invitation = { render: () => <PairingView state={invited} /> };
export const Checking = { render: () => <PairingView state={{ kind: "checking" }} /> };
export const Unknown = {
  render: () => <PairingView state={{ kind: "unknown", onInspect: noop }} />,
};
export const Completed = {
  render: () => <PairingView state={{ kind: "completed", onCreate: noop }} />,
};
export const Refused = {
  render: () => <PairingView state={{ kind: "refused", onCreate: noop }} />,
};
export const Unavailable = { render: () => <PairingView state={{ kind: "unavailable" }} /> };
export const Expired = {
  render: () => <PairingView state={{ kind: "expired", onCreate: noop }} />,
};
export const SyncOff = {
  render: () => <PairingView state={{ kind: "sync_off", onCreate: noop }} onGoToSync={() => {}} />,
};
export const WaitingForPhone = { render: () => <PairingView state={{ kind: "waiting" }} /> };
