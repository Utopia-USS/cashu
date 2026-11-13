// A layer above everything the app shows: sheets (formSheet) and triage (fullScreenModal) are native
// view controllers presented above the root view, so on iOS the layer lives in `FullWindowOverlay`
// (its own window above every presentation); elsewhere it is the children as they are, an absolute
// layer over the root. The app-switcher cover and the lock screen.
import type { ReactNode } from "react";
import { Platform } from "react-native";
import { FullWindowOverlay } from "react-native-screens";

export function AboveAll({ children }: { children: ReactNode }) {
  return Platform.OS === "ios" ? <FullWindowOverlay>{children}</FullWindowOverlay> : children;
}
