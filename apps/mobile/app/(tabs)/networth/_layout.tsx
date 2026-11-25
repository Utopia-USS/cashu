// The Net worth tab's stack (see the Today tab's layout): the tab root and the loan page.
import { Stack } from "expo-router";
import { S } from "../../../src/shell/Shell.strings";

export const unstable_settings = { initialRouteName: "index" };

export default function NetWorthLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false, title: S.tabNetWorth }} />
      <Stack.Screen name="loan/[gid]" options={{ title: "" }} />
    </Stack>
  );
}
