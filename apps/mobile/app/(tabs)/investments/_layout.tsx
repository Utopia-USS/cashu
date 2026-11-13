// The Investments tab's stack (see the Today tab's layout): the tab root (Portfolio / Signals / Strategy),
// then the pushed position and research note pages, whose back button names the tab. While the tab is
// in front, the phone keeps the vault's market prices fresh itself (`usePricesRefresh`).
import { enabledModules } from "@cashu/store/core/profile";
import { useQuery } from "@cashu/store-react";
import { Stack } from "expo-router";
import { usePricesRefresh } from "../../../src/services/usePricesRefresh";
import { S } from "../../../src/shell/Shell.strings";

export const unstable_settings = { initialRouteName: "index" };

export default function InvestmentsLayout() {
  usePricesRefresh({ enabled: useQuery(enabledModules).includes("investments") });
  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
      <Stack.Screen name="index" options={{ headerShown: false, title: S.tabInvestments }} />
      <Stack.Screen name="position/[gid]" options={{ title: "" }} />
      <Stack.Screen name="note/[gid]" options={{ title: "" }} />
    </Stack>
  );
}
