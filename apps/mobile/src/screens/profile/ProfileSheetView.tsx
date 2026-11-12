// The profile sheet (prototype `profile` sheet): the profiles on this phone, this phone's incognito
// switch, what waits on the Mac, the Mac-only note and the app version; Diagnostics and Bench in dev.
import { Button, Icon, ListRow, NoteLine, ToggleRow } from "@cashu/ui/native";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { ProfileAvatar } from "../../shell/ProfileAvatar";
import { S } from "./Profile.strings";
import type { ProfileSheetState } from "./useProfileSheet";

export type ProfileSheetViewProps = ProfileSheetState;

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      {title !== undefined && (
        <Text role="heading" className="px-1 text-caption font-demi text-fg-muted">
          {title}
        </Text>
      )}
      <View className="rounded-xl bg-surface-raised px-4">{children}</View>
    </View>
  );
}

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
      <Section title={S.profiles}>
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
      </Section>
      {props.switchFailed && (
        <Text accessibilityRole="alert" className="-mt-3 px-1 text-caption text-negative">
          {S.couldNotSwitch}
        </Text>
      )}
      <Section title={S.thisPhone}>
        <ToggleRow
          label={S.hideAmounts}
          sub={S.hideAmountsSub}
          value={props.incognito}
          onChange={props.onIncognitoToggle}
        />
      </Section>
      <Section title={S.waitingOnMac}>
        <ListRow
          first
          lead={<Icon name="doc" size={20} className="text-fg-muted" />}
          name={
            props.waiting.kind === "proposals" ? S.proposals(props.waiting.count) : S.nothingWaiting
          }
        />
      </Section>
      <NoteLine icon="laptop">{S.macOnly}</NoteLine>
      {props.dev && (
        <Section>
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
        </Section>
      )}
      <Text className="text-center text-caption text-fg-muted">{S.version(props.version)}</Text>
    </ScrollView>
  );
}
