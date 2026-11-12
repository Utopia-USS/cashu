// The Activity tab's stack (see the Today tab's layout).
import { Stack } from "expo-router";
import { S } from "../../../src/shell/Shell.strings";

export const unstable_settings = { initialRouteName: "index" };

export default function ActivityLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false, title: S.tabActivity }} />
    </Stack>
  );
}
