// Root layout: the token stylesheet (packages/ui theme, compiled by Uniwind), the app services, the
// navigation stack. Debug scaffold (S41): the demo vault only.
import "@cashu/ui/theme.css";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui";
import { Stack } from "expo-router";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { useColorScheme } from "react-native";
import { S as Bench } from "../src/screens/bench/Bench.strings";
import { S as Debug } from "../src/screens/debug/Debug.strings";
import { ServicesProvider } from "../src/services/ServicesProvider";
import { bootServices } from "../src/services/services";

const services = bootServices();

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ServicesProvider services={services}>
      <StoreProvider client={services.client}>
        <ProfileProvider>
          {/* Privacy mode comes from the store's device-local settings once they exist (synthetic data here). */}
          <UiEnvProvider privacy={false}>
            <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
              <Stack>
                <Stack.Screen name="index" options={{ title: Debug.title }} />
                <Stack.Screen name="bench" options={{ title: Bench.title }} />
              </Stack>
            </ThemeProvider>
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}
