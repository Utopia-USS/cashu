// Root layout: the token stylesheet (packages/ui theme, compiled by Uniwind), the app services, the
// store and the current profile, the phone's notifications (the planner and the taps), its sync
// triggers, the app environment (incognito, bananas, app-switcher cover) and the root stack: the tabs,
// the sheets and modals over them, and the developer screens. Everything under the services sits in
// the root's phase gate: nothing while the services open, while the phone wipe runs the tree is
// replaced by the "Removing" state, after it the tree remounts under a new epoch (every query cache,
// subscription and screen state starts over, the stack starts at the index, which goes to Today), and
// a wipe that could not finish shows the fatal state.
import "@cashu/ui/native.css";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { Stack } from "expo-router";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { useSyncExternalStore } from "react";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { PhoneNotifications } from "../src/notifications/PhoneNotifications";
import { S as Bench } from "../src/screens/bench/Bench.strings";
import { S as Debug } from "../src/screens/debug/Debug.strings";
import { subscribeEpoch } from "../src/services/lifecycle";
import { ServicesProvider } from "../src/services/ServicesProvider";
import { bootServices, startServices } from "../src/services/services";
import { AppEnv } from "../src/shell/AppEnv";
import { RootPhaseGate } from "../src/shell/RootPhaseGate";
import { installPhoneIncognito } from "../src/shell/useAppEnv";
import { PhoneSync } from "../src/sync/PhoneSync";

// A render error in the shell (AppEnv, the profile provider) gets expo-router's retry screen.
export { ErrorBoundary } from "expo-router";

// Built before the first render when that is synchronous (the demo: the native splash covers the
// first launch's fixture build); a phone with paired vaults opens their keys first (the opening phase).
startServices();
installPhoneIncognito();

const sheet = { presentation: "formSheet", sheetGrabberVisible: true, headerShown: false } as const;

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <RootPhaseGate>
        <AppRoot />
      </RootPhaseGate>
    </GestureHandlerRootView>
  );
}

/** The app over the current services; mounted only while the root is ready (never over closed stores). */
function AppRoot() {
  const scheme = useColorScheme();
  // From the epoch's store (never a bare call in render, which the compiler would cache once).
  const services = useSyncExternalStore(subscribeEpoch, bootServices);
  return (
    <ServicesProvider services={services}>
      <StoreProvider client={services.client}>
        <ProfileProvider>
          <PhoneNotifications />
          <PhoneSync />
          <AppEnv>
            <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
              <Stack>
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen
                  name="sheet/profile"
                  options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }}
                />
                <Stack.Screen
                  name="sheet/payment/[gid]"
                  options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }}
                />
                <Stack.Screen
                  name="sheet/alert/[gid]"
                  options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }}
                />
                <Stack.Screen name="sheet/cash" options={{ ...sheet, sheetAllowedDetents: [1] }} />
                <Stack.Screen
                  name="modal/triage"
                  options={{ presentation: "fullScreenModal", headerShown: false }}
                />
                <Stack.Screen
                  name="modal/review"
                  options={{ presentation: "fullScreenModal", headerShown: false }}
                />
                <Stack.Screen
                  name="modal/pair"
                  options={{
                    presentation: "fullScreenModal",
                    headerShown: false,
                    gestureEnabled: false,
                  }}
                />
                <Stack.Protected guard={__DEV__}>
                  <Stack.Screen name="debug" options={{ title: Debug.title }} />
                  <Stack.Screen name="bench" options={{ title: Bench.title }} />
                </Stack.Protected>
              </Stack>
            </ThemeProvider>
          </AppEnv>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}
