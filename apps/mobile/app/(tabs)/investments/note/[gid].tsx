// A research note, pushed from the Signals view and the position page (the native header has no title:
// the note's own title leads the page). Source links open in the system browser.
import { lang } from "@cashu/i18n";
import { Stack, useLocalSearchParams } from "expo-router";
import { Linking } from "react-native";
import { NoteView } from "../../../../src/screens/note/NoteView";
import { useNoteScreen } from "../../../../src/screens/note/useNoteScreen";
import { useNow } from "../../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function NoteRoute() {
  const { gid } = useLocalSearchParams<{ gid: string }>();
  const { today, now } = useNow();
  const props = useNoteScreen({
    gid,
    lang: lang(),
    today,
    now,
    openLink: (url) => {
      void Linking.openURL(url).catch(() => {});
    },
  });
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <NoteView {...props} />
    </>
  );
}
