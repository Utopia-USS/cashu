// Stories of the notifications settings (CSF 3, synthetic alerts): an owner with investments and a
// marked alert, an owner with none marked, a partner, permission not asked yet and denied, a release
// build without the preview, and the device-change and bank-permission rows as they will show once their
// data reaches the phone (S44 / a synced consent date).
import { NotificationsView, type NotificationsViewProps } from "./NotificationsView";

const base: NotificationsViewProps = {
  role: "owner",
  investments: true,
  permission: null,
  prefs: {
    alertsFired: true,
    weekly: true,
    monthClosed: true,
    evening: false,
    staleData: true,
    consentEnding: true,
  },
  markedAlerts: "CDR -8% in 5 sessions, VT below USD 110",
  deviceChangesAvailable: false,
  consentAvailable: false,
  weeklyTime: "18:00",
  eveningTime: "19:00",
  staleAfterHours: 36,
  consentDays: [7, 1],
  onToggle: () => {},
  preview: { onPreview: async () => {} },
};

const meta = { title: "Mobile/Notifications/Settings", component: NotificationsView, args: base };
export default meta;

export const Owner = { args: {} };
export const NoneMarked = {
  args: { markedAlerts: null, prefs: { ...base.prefs, alertsFired: false } },
};
export const Partner = {
  args: {
    role: "partner",
    investments: false,
    markedAlerts: null,
    prefs: { ...base.prefs, alertsFired: false, evening: true },
  },
};
export const NotAskedYet = {
  args: { permission: { kind: "undetermined", onAllow: async () => {} } },
};
export const Denied = { args: { permission: { kind: "denied", onOpenSettings: () => {} } } };
export const Release = { args: { preview: null } };
export const AllRowsAvailable = { args: { deviceChangesAvailable: true, consentAvailable: true } };
export const PartnerWithDeviceChanges = {
  args: { ...Partner.args, deviceChangesAvailable: true },
};
