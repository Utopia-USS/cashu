// The notifications settings screen (prototype `notifs`, pushed in the Today stack from the profile
// sheet): the permission state when iOS has not allowed them, what is told when the phone next syncs,
// the digests and the one-time warnings with their switches, the counts-only and never-sent notes, and a
// dev-only preview of tonight's digests. An owner and a partner see different shapes. Pure.
import type { NotificationPrefs } from "@cashu/domain/core/notifications";
import { Button, GroupSection, Icon, ListRow, NoteLine, ToggleRow } from "@cashu/ui/native";
import { ScrollView, View } from "react-native";
import { S } from "./NotificationsScreen.strings";

/** The choices a switch changes (`deviceChanges` is always on). */
type NotificationChoice = Exclude<keyof NotificationPrefs, "deviceChanges">;

export interface NotificationsViewProps {
  readonly role: "owner" | "partner";
  /** The profile follows investments (the review and the plan lines, the marked alerts). */
  readonly investments: boolean;
  /** Null while the state is not read yet, and once iOS allows notifications. */
  readonly permission:
    | { readonly kind: "undetermined"; onAllow(): Promise<void> }
    | { readonly kind: "denied"; onOpenSettings(): void }
    | null;
  readonly prefs: Omit<NotificationPrefs, "deviceChanges">;
  /** The marked alerts' titles, joined; null when none is marked. */
  readonly markedAlerts: string | null;
  /** TRANSITIONAL(S44): the device-change row shows once the phone has a device registry. */
  readonly deviceChangesAvailable: boolean;
  /**
   * The bank-permission warning shows once a consent end date reaches the phone; today it lives only in
   * the host's secrets (computed for the bank's /auth request, never synced).
   */
  readonly consentAvailable: boolean;
  /** "Sunday, 18:00", "Evening, 19:00" times, in the phone's locale. */
  readonly weeklyTime: string;
  readonly eveningTime: string;
  /** Hours of the first stale warning; days of the two permission warnings. */
  readonly staleAfterHours: number;
  readonly consentDays: readonly [number, number];
  onToggle(choice: NotificationChoice, value: boolean): void;
  /** Dev builds only: schedules tonight's digests a few seconds ahead. */
  readonly preview: { onPreview(): Promise<void> } | null;
}

function Permission({ permission }: { permission: NotificationsViewProps["permission"] }) {
  if (permission === null) return null;
  if (permission.kind === "undetermined")
    return (
      <Button variant="primary" block onPress={permission.onAllow}>
        {S.allow}
      </Button>
    );
  return (
    <View className="gap-3">
      <NoteLine icon="bell">{S.denied}</NoteLine>
      <Button variant="secondary" block onPress={permission.onOpenSettings}>
        {S.openSettings}
      </Button>
    </View>
  );
}

export function NotificationsView(props: NotificationsViewProps) {
  const owner = props.role === "owner";
  const { prefs, onToggle } = props;
  // The owner's investing lines: the marked alerts, the review, the plan (a partner follows the budget).
  const alerts = owner && props.investments;
  const [firstDays, lastDays] = props.consentDays;
  return (
    <ScrollView
      className="flex-1 bg-surface"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-5 px-4 pt-4 pb-10"
    >
      <Permission permission={props.permission} />
      {(alerts || props.deviceChangesAvailable) && (
        <GroupSection title={S.whenSynced}>
          {alerts && (
            <ToggleRow
              label={S.markedAlerts}
              sub={props.markedAlerts ?? S.noMarkedAlerts}
              value={prefs.alertsFired}
              onChange={(value) => onToggle("alertsFired", value)}
            />
          )}
          {props.deviceChangesAvailable && (
            <ToggleRow
              label={S.deviceChanges}
              sub={S.deviceChangesSub}
              value
              fixed
              onChange={() => {}}
            />
          )}
        </GroupSection>
      )}
      <GroupSection title={S.digests}>
        <ToggleRow
          label={S.weekly(props.weeklyTime)}
          sub={S.weeklySub(alerts)}
          value={prefs.weekly}
          onChange={(value) => onToggle("weekly", value)}
        />
        <ToggleRow
          label={S.monthClosed}
          sub={S.monthClosedSub(alerts)}
          value={prefs.monthClosed}
          onChange={(value) => onToggle("monthClosed", value)}
        />
        <ToggleRow
          label={S.evening(props.eveningTime)}
          sub={S.eveningSub}
          value={prefs.evening}
          onChange={(value) => onToggle("evening", value)}
        />
      </GroupSection>
      {owner && (
        <GroupSection title={S.warnings}>
          <ToggleRow
            label={S.staleData}
            sub={S.staleDataSub(props.staleAfterHours)}
            value={prefs.staleData}
            onChange={(value) => onToggle("staleData", value)}
          />
          {props.consentAvailable && (
            <ToggleRow
              label={S.consentEnding}
              sub={S.consentEndingSub(firstDays, lastDays)}
              value={prefs.consentEnding}
              onChange={(value) => onToggle("consentEnding", value)}
            />
          )}
        </GroupSection>
      )}
      <NoteLine icon="shield">{S.countsOnly}</NoteLine>
      <NoteLine icon="x">{S.neverSent(owner)}</NoteLine>
      {props.preview !== null && (
        <GroupSection>
          <ListRow
            first
            name={S.preview}
            sub={S.previewSub}
            value={<Icon name="bell" size={20} className="text-fg-muted" />}
            onPress={props.preview.onPreview}
          />
        </GroupSection>
      )}
    </ScrollView>
  );
}
