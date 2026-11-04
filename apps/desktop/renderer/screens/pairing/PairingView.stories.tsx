import { PairingView, type PairingViewState } from "./PairingView.js";

const noop = () => {};
const invited: PairingViewState = {
  kind: "invited",
  qr: "synthetic-invitation",
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
