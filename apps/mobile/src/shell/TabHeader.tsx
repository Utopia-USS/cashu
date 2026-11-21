// The header every tab root renders at the top (prototype `topBar`): the profile pill, the offline chip,
// an optional action and the eye button on one row, then the large title and the freshness line. Not a
// native header: tab roots set `headerShown: false`.
import { FreshLine, Icon } from "@cashu/ui/native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ProfileAvatar } from "./ProfileAvatar";
import { S } from "./Shell.strings";

/** The freshness line under the title: a status dot and its text. */
export interface TabFresh {
  tone: "ok" | "warn" | "muted";
  text: string;
}

export interface TabHeaderProps {
  profile: { initial: string; name: string };
  title: string;
  fresh: TabFresh | null;
  /** The pending local writes chip ("2 changes waiting"); null in M1. */
  offline: string | null;
  incognito: boolean;
  /** An action left of the eye button (the "Cash" button on Activity). */
  right?: ReactNode;
  onProfilePress(): void;
  onIncognitoToggle(): void;
}

/** The 40 pt pill and eye button grow to the 44 pt minimum touch target without changing their look. */
const HIT_SLOP = 2;

export function TabHeader({
  profile,
  title,
  fresh,
  offline,
  incognito,
  right,
  onProfilePress,
  onIncognitoToggle,
}: TabHeaderProps) {
  return (
    <View className="px-4 pt-2">
      <View className="min-h-11 flex-row items-center justify-between gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={S.openProfile(profile.name)}
          onPress={onProfilePress}
          hitSlop={HIT_SLOP}
          className="min-h-10 shrink flex-row items-center gap-2 rounded-full bg-chip pr-3 pl-1.25 active:opacity-70"
        >
          <ProfileAvatar initial={profile.initial} />
          <Text numberOfLines={1} className="shrink text-sm-plus font-demi text-fg-secondary">
            {profile.name}
          </Text>
          <Icon name="chevron-down" className="text-fg-muted" />
        </Pressable>
        <View className="flex-row items-center gap-2">
          {offline !== null && (
            <View className="min-h-6.5 py-0.5 flex-row items-center gap-1.5 rounded-full bg-chip px-2.25">
              <Icon name="sync" className="text-fg-secondary" />
              <Text className="text-2xs-plus text-fg-secondary">{offline}</Text>
            </View>
          )}
          {right}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={incognito ? S.showAmounts : S.hideAmounts}
            accessibilityState={{ selected: incognito }}
            onPress={onIncognitoToggle}
            hitSlop={HIT_SLOP}
            className={`size-10 items-center justify-center rounded-full active:opacity-70 ${incognito ? "bg-accent-muted" : "bg-chip"}`}
          >
            <Icon
              name={incognito ? "eye-off" : "eye"}
              size={20}
              className={incognito ? "text-accent" : "text-fg-secondary"}
            />
          </Pressable>
        </View>
      </View>
      <Text role="heading" className="mt-2 text-display font-bold tracking-dense text-fg">
        {title}
      </Text>
      {fresh !== null && (
        <View className="mt-0.5 mb-3.5">
          <FreshLine tone={fresh.tone}>{fresh.text}</FreshLine>
        </View>
      )}
    </View>
  );
}
