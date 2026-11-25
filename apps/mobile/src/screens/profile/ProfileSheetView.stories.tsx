// Stories of the profile sheet (CSF 3, synthetic profiles): the owner with two profiles and nothing
// waiting (no "Waiting for you on the Mac" section, only the line about the Mac), proposals waiting, incognito on, notifications off in iOS Settings, a partner phone with one profile, a release build, the app
// lock on, a Touch ID phone and a phone with nothing set up to unlock with; a paired phone whose sync is paused or
// was turned off on the Mac.
import { ProfileSheetView, type ProfileSheetViewProps } from "./ProfileSheetView";

const base: ProfileSheetViewProps = {
  kind: "ready",
  profiles: [
    {
      vault: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaa001",
      name: "Anna",
      initial: "A",
      current: true,
      modules: ["Budget", "Assets", "Investments"],
    },
    {
      vault: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbb002",
      name: "Home",
      initial: "H",
      current: false,
      modules: ["Budget", "Assets", "Loans"],
    },
  ],
  incognito: false,
  isSwitching: false,
  switchFailed: false,
  waiting: { kind: "nothing" },
  notificationsOff: false,
  phone: { name: "This iPhone", sub: "demo data" },
  pairing: null,
  role: null,
  unavailable: [],
  removeFailed: false,
  sync: { line: null, notice: null },
  onPair: () => {},
  onRoleChanged: () => {},
  onRemoveCopy: () => {},
  version: "0.0.0",
  dev: true,
  onProfilePicked: () => {},
  onIncognitoToggle: () => {},
  lock: { enabled: false, capability: "face", isPending: false },
  onLockToggle: () => {},
  onRemovePhone: () => {},
  onNotifications: () => {},
  onDiagnostics: () => {},
  onBench: () => {},
  onClose: () => {},
};

const meta = { title: "Mobile/Profile/ProfileSheet", component: ProfileSheetView, args: base };
export default meta;

export const Owner = { args: {} };
export const ProposalsWaiting = { args: { waiting: { kind: "proposals", count: 2 } } };
export const IncognitoOn = { args: { incognito: true } };
export const NotificationsOff = { args: { notificationsOff: true } };
export const Partner = {
  args: {
    profiles: [
      {
        vault: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbb002",
        name: "Home",
        initial: "H",
        current: true,
        modules: ["Budget", "Assets", "Loans"],
      },
    ],
  },
};
export const Release = { args: { dev: false } };
export const SwitchFailed = { args: { switchFailed: true } };
export const LockOn = { args: { lock: { enabled: true, capability: "face", isPending: false } } };
export const LockTouchId = {
  args: { lock: { enabled: false, capability: "fingerprint", isPending: false } },
};
export const LockUnavailable = {
  args: { lock: { enabled: false, capability: "none", isPending: false } },
};
export const PairFirst = { args: { pairing: { first: true } } };
export const PairedOwner = {
  args: {
    pairing: { first: false },
    role: "owner" as const,
    phone: { name: "iPhone 16 Pro", sub: "added 14.11.2026 by Anna's MacBook" },
  },
};
export const PairedPartner = { args: { ...PairedOwner.args, role: "partner" as const } };
export const ProfileDoesNotOpen = {
  args: {
    ...PairedOwner.args,
    unavailable: [
      {
        vault: "ccccccccccccccccccccccccccccc003",
        text: "cashU can't open Home on this phone. Pair it again with your Mac, or remove this copy.",
      },
    ],
  },
};
export const SyncPaused = {
  args: {
    ...PairedOwner.args,
    sync: {
      line: { text: "Sync paused since 19:50 · cashU works as usual", tone: "muted" as const },
      notice: null,
    },
  },
};
export const SyncTurnedOff = {
  args: {
    ...PairedOwner.args,
    sync: {
      line: null,
      notice: {
        kind: "syncOff" as const,
        title:
          "Sync for Anna was turned off on your Mac. The copy on this phone stays until you remove it.",
        body: null,
        actions: [
          { label: "Remove this copy", tone: "danger" as const, onPress: () => {} },
          { label: "Keep for now", tone: "secondary" as const, onPress: () => {} },
        ],
        failed: false,
      },
    },
  },
};
