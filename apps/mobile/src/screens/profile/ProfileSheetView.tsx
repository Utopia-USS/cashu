// The profile sheet (prototype `profile` sheet): the profiles on this phone, this phone's notifications
// page, app lock and incognito switches, what waits on the Mac, the Mac-only note, Diagnostics and
// Bench in dev, this phone with "Remove this phone" last, and the app version.
import { Button, GroupSection, Icon, ListRow, NoteLine, ToggleRow } from "@cashu/ui/native";
import { ScrollView, Text, View } from "react-native";
import { ProfileAvatar } from "../../shell/ProfileAvatar";
import { S } from "./Profile.strings";
import type { ProfileSheetState } from "./useProfileSheet";

export type ProfileSheetViewProps = ProfileSheetState;

export function ProfileSheetView(props: ProfileSheetViewProps) {
  return (
    <ScrollView className="flex-1 bg-surface" contentContainerClassName="gap-5 px-4 pt-6 pb-10">
      <View className="flex-row items-center justify-between gap-3">
        <Text role="heading" className="shrink text-headline font-strong text-fg">
          {S.title}
        </Text>
        <Button variant="glyph" label={S.close} onPress={props.onClose}>
          <Icon name="x" size={20} />
        </Button>
      </View>
      <GroupSection title={S.profiles}>
        {props.profiles.map((p, i) => (
          <ListRow
            key={p.vault}
            first={i === 0}
            lead={<ProfileAvatar initial={p.initial} />}
            name={p.name}
            sub={p.modules.join(", ")}
            value={p.current ? <Icon name="check" size={20} className="text-accent" /> : undefined}
            accessibilityLabel={p.current ? S.current(p.name) : S.pickProfile(p.name)}
            onPress={props.isSwitching ? undefined : () => props.onProfilePicked(p.vault)}
          />
        ))}
      </GroupSection>
      {props.switchFailed && (
        <Text accessibilityRole="alert" className="-mt-3 px-1 text-caption text-negative">
          {S.couldNotSwitch}
        </Text>
      )}
      <GroupSection title={S.thisPhone}>
        <ListRow
          first
          name={S.notifications}
          {...(props.notificationsOff ? { sub: S.notificationsOff } : {})}
          value={<Icon name="chevron-right" className="text-fg-muted" />}
          onPress={props.onNotifications}
        />
        <ToggleRow
          label={S.lockLabel(props.lock.capability)}
          {...(props.lock.capability === "none" ? { sub: S.lockNoneSub } : {})}
          value={props.lock.enabled}
          disabled={props.lock.capability === "none" || props.lock.isPending}
          onChange={props.onLockToggle}
        />
        <ToggleRow
          label={S.hideAmounts}
          sub={S.hideAmountsSub}
          value={props.incognito}
          onChange={props.onIncognitoToggle}
        />
      </GroupSection>
      <GroupSection title={S.waitingOnMac}>
        <ListRow
          first
          lead={<Icon name="doc" size={20} className="text-fg-muted" />}
          name={
            props.waiting.kind === "proposals" ? S.proposals(props.waiting.count) : S.nothingWaiting
          }
        />
      </GroupSection>
      <NoteLine icon="laptop">{S.macOnly}</NoteLine>
      {props.dev && (
        <GroupSection>
          <ListRow
            first
            name={S.diagnostics}
            value={<Icon name="chevron-right" className="text-fg-muted" />}
            onPress={props.onDiagnostics}
          />
          <ListRow
            name={S.bench}
            value={<Icon name="chevron-right" className="text-fg-muted" />}
            onPress={props.onBench}
          />
        </GroupSection>
      )}
      <GroupSection>
        <ListRow first name={props.phone.name} sub={props.phone.sub} />
        <ListRow
          name={S.removePhone}
          sub={S.removePhoneSub}
          tone="danger"
          onPress={props.onRemovePhone}
        />
      </GroupSection>
      <Text className="text-center text-caption text-fg-muted">{S.version(props.version)}</Text>
    </ScrollView>
  );
}
