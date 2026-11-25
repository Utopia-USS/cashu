// A position's page, pushed from the Investments tab and Today's "worth a look"; the native header names
// the instrument. Opens the alert sheet of a waiting signal and the research notes about it.
import { lang } from "@cashu/i18n";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { S } from "../../../../src/screens/position/Position.strings";
import { PositionView } from "../../../../src/screens/position/PositionView";
import { usePositionScreen } from "../../../../src/screens/position/usePositionScreen";
import { useNow } from "../../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function PositionRoute() {
  const router = useRouter();
  const { gid } = useLocalSearchParams<{ gid: string }>();
  const { today, now } = useNow();
  const props = usePositionScreen({
    gid,
    lang: lang(),
    today,
    now,
    openAlert: (signal) => router.push({ pathname: "/sheet/alert/[gid]", params: { gid: signal } }),
    openNote: (note) =>
      router.push({ pathname: "/(tabs)/investments/note/[gid]", params: { gid: note } }),
  });
  return (
    <>
      <Stack.Screen options={{ title: props.kind === "ready" ? props.title : S.position }} />
      <PositionView {...props} />
    </>
  );
}
