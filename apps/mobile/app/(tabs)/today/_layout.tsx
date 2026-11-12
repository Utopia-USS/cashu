// The Today tab's stack: the tab root draws its own header; pushed screens get native headers whose
// back button names the tab.
import { Stack } from "expo-router";
import { S as Spending } from "../../../src/screens/spending/Spending.strings";
import { S } from "../../../src/shell/Shell.strings";

export const unstable_settings = { initialRouteName: "index" };

export default function TodayLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false, title: S.tabToday }} />
      <Stack.Screen name="spending" options={{ title: Spending.title }} />
    </Stack>
  );
}
