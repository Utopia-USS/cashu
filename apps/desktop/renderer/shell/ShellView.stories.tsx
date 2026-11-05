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
  pendingModules: ["assets"],
  locale: "en-US",
  profile,
  profiles: [
    profile,
    { ...profile, slug: "second", name: "Second", displayName: "Second", vault: "b" },
  ],
  vault: "a",
  privacy: false,
  toast: null,
  connectionText: "Connected.",
  connectionOk: true,
  isSwitching: false,
  onPrivacyChanged: () => {},
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
    onModuleOpened: () => {},
  },
};
export const Ready = {};
export const NoProfile = { args: { state: { ...state, profile: null } } };
export const Privacy = { args: { state: { ...state, privacy: true } } };
export const Reconnecting = {
  args: {
    state: {
      ...state,
      connectionText: "Reconnecting; displayed data may be stale.",
      connectionOk: false,
    },
  },
};
export const Toast = { args: { state: { ...state, toast: "Profile changed." } } };
