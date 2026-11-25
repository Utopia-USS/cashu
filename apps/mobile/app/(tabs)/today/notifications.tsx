// The notifications settings, pushed in the Today stack from the profile sheet's "Notifications" row,
// under a native header back to Today.
import { Stack } from "expo-router";
import { Linking } from "react-native";
import { expoScheduler } from "../../../src/platform/notifications";
import { S } from "../../../src/screens/notifications/NotificationsScreen.strings";
import { NotificationsView } from "../../../src/screens/notifications/NotificationsView";
import { useNotificationsScreen } from "../../../src/screens/notifications/useNotificationsScreen";

export { ErrorBoundary } from "expo-router";

export default function NotificationsRoute() {
  const props = useNotificationsScreen({
    scheduler: expoScheduler,
    openSettings: () => {
      void Linking.openSettings();
    },
  });
  return (
    <>
      <Stack.Screen options={{ title: S.title }} />
      <NotificationsView {...props} />
    </>
  );
}
