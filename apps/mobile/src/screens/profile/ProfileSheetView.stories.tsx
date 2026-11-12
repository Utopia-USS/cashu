// Stories of the profile sheet (CSF 3, synthetic profiles): the owner with two profiles and nothing
// waiting, proposals waiting, incognito on, a partner phone with one profile, a release build.
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
  version: "0.0.0",
  dev: true,
  onProfilePicked: () => {},
  onIncognitoToggle: () => {},
  onDiagnostics: () => {},
  onBench: () => {},
  onClose: () => {},
};

const meta = { title: "Mobile/Profile/ProfileSheet", component: ProfileSheetView, args: base };
export default meta;

export const Owner = { args: {} };
export const ProposalsWaiting = { args: { waiting: { kind: "proposals", count: 2 } } };
export const IncognitoOn = { args: { incognito: true } };
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
