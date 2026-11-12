// Root layout: the token stylesheet (packages/ui theme, compiled by Uniwind), the app services, the
// store and the current profile, the app environment (incognito, bananas, app-switcher cover) and the
// root stack: the tabs, the sheets and modals over them, and the developer screens.
import "@cashu/ui/native.css";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { Stack } from "expo-router";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { S as Bench } from "../src/screens/bench/Bench.strings";
import { S as Debug } from "../src/screens/debug/Debug.strings";
import { ServicesProvider } from "../src/services/ServicesProvider";
import { bootServices } from "../src/services/services";
import { AppEnv } from "../src/shell/AppEnv";
import { installPhoneIncognito } from "../src/shell/useAppEnv";

// A render error in the shell (AppEnv, the profile provider) gets expo-router's retry screen.
export { ErrorBoundary } from "expo-router";

const services = bootServices();
installPhoneIncognito();

const sheet = { presentation: "formSheet", sheetGrabberVisible: true, headerShown: false } as const;

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ServicesProvider services={services}>
        <StoreProvider client={services.client}>
          <ProfileProvider>
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
                    name="sheet/cash"
                    options={{ ...sheet, sheetAllowedDetents: [1] }}
                  />
                  <Stack.Screen
                    name="modal/triage"
                    options={{ presentation: "fullScreenModal", headerShown: false }}
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
    </GestureHandlerRootView>
  );
}
