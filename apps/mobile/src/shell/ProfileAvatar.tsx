// A profile's avatar (prototype `.av`): its initial in a 30 pt circle. The tab header's profile pill and
// the profile sheet's rows; the name beside it names it for assistive technology.
import { Text, View } from "react-native";

export function ProfileAvatar({ initial }: { initial: string }) {
  return (
    <View className="size-7.5 items-center justify-center rounded-full bg-accent-muted">
      <Text className="text-caption font-heavy text-fg">{initial}</Text>
    </View>
  );
}
