import { S } from "../Desktop.strings.js";
import { ShellView, type ShellViewProps } from "./ShellView.js";

const profile = {
  slug: "synthetic",
  name: "Synthetic",
  displayName: "Synthetic",
  baseCurrency: "PLN",
  vault: "a",
};
const state: ShellViewProps["state"] = {
  enabledModules: ["budget", "assets"],
  locale: "en-US",
  profile,
  canOpenLegacy: true,
  onLegacyRefused: () => {},
  profiles: [
    profile,
    { ...profile, slug: "second", name: "Second", displayName: "Second", vault: "b" },
  ],
  vault: "a",
  privacy: false,
  toast: null,
  connectionText: "Connected.",
  language: "en",
  isSwitching: false,
  onPrivacyChanged: () => {},
  onLanguagePicked: () => {},
  onProfilePicked: async () => {},
  onRouteVaultPicked: async () => {},
  onToastDismissed: () => {},
};
export default {
  title: "Desktop/Shell",
  component: ShellView,
  args: {
    state,
    children: <p>{S.overview}</p>,
    onOverviewOpened: () => {},
    onLegacyOpened: () => {},
  },
};
export const Ready = {};
export const LegacyUnavailable = {
  args: { state: { ...state, canOpenLegacy: false }, children: <p>{S.ambiguousProfile}</p> },
};
export const Privacy = { args: { state: { ...state, privacy: true } } };
export const Reconnecting = {
  args: { state: { ...state, connectionText: "Reconnecting; displayed data may be stale." } },
};
export const Toast = { args: { state: { ...state, toast: "Profile changed." } } };
