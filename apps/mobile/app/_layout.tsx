// Root layout: the token stylesheet (packages/ui theme, compiled by Uniwind), the app services, the
// navigation stack. The current vault is still the synthetic S41 demo vault.
import "@cashu/ui/native.css";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { Stack } from "expo-router";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { useColorScheme } from "react-native";
import { S as Bench } from "../src/screens/bench/Bench.strings";
import { S as Cashflow } from "../src/screens/cashflow/Cashflow.strings";
import { S as Debug } from "../src/screens/debug/Debug.strings";
import { S as Money } from "../src/screens/money/Money.strings";
import { S as Spending } from "../src/screens/spending/Spending.strings";
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
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen name="money" options={{ title: Money.title }} />
                <Stack.Screen name="cashflow" options={{ title: Cashflow.title }} />
                <Stack.Screen name="spending" options={{ title: Spending.title }} />
                <Stack.Screen name="debug" options={{ title: Debug.title }} />
                <Stack.Screen name="bench" options={{ title: Bench.title }} />
              </Stack>
            </ThemeProvider>
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}
