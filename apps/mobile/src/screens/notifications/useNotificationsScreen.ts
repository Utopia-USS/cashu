// The notifications settings screen's hook: the current profile's choices and marked alerts from the
// device store (their titles from the alert signals, only with investments), the profile's role and
// modules, the iOS permission (asked the first time the screen opens while undetermined, read again when
// the app comes back from Settings) and, in dev builds, a preview of tonight's digests. A switch writes
// `setNotificationPrefs`; the shell's planner re-plans on its own when a choice changes, and on
// `requestReplan` once the permission turns granted (the iOS prompt, or iOS Settings).
import {
  CONSENT_RUNGS_DAYS,
  EVENING_HOUR,
  STALE_RUNGS_HOURS,
  WEEKLY_HOUR,
} from "@cashu/domain/core/notifications";
import { intlLocale, lang } from "@cashu/i18n";
import { formatClockTime } from "@cashu/i18n/values";
import { markedAlerts, notificationPrefs, setNotificationPrefs } from "@cashu/store/device";
import { useCommand, useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AppState } from "react-native";
import { previewNotifications } from "../../notifications/planner";
import { requestReplan } from "../../notifications/replan";
import type { NotificationPermission, NotificationScheduler } from "../../notifications/scheduler";
import { deviceTimeZone } from "../../services/investments";
import { useServices } from "../../services/ServicesProvider";
import { useNow } from "../../shell/useNow";
import { safeText } from "../investments/signalText";
import { localToday } from "../screenContext";
import { markedAlertTitles } from "./markedAlertTitles";
import type { NotificationsViewProps } from "./NotificationsView";

/** The dev preview arrives this long after the tap (time to lock the screen). */
const PREVIEW_DELAY_MS = 5_000;

/** A wall-clock hour as a setting label reads it ("18:00", "6:00 PM"). */
function hourText(hour: number, locale: string): string {
  return formatClockTime(new Date(2000, 0, 2, hour), locale, { naturalHour: true });
}

export function useNotificationsScreen(args: {
  readonly scheduler: NotificationScheduler;
  /** Opens cashU's page in iOS Settings (the route binds `Linking.openSettings`). */
  openSettings(): void;
}): NotificationsViewProps {
  const { scheduler } = args;
  const services = useServices();
  const vault = useProfile();
  const { locale, privacy } = useUiEnv();
  const { now } = useNow();
  const profile = services.profiles.find((p) => p.vault === vault);
  const invests = profile?.modules.includes("investments") ?? false;
  const prefs = useQuery(notificationPrefs, { vault });
  const marked = useQuery(markedAlerts, { vault });
  const titles = useQuery(markedAlertTitles, { now, marked: invests ? marked : [] });
  const write = useCommand(setNotificationPrefs);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const asked = useRef(false);
  /** The last state read, to notice it turning granted (in iOS Settings while the app was away). */
  const last = useRef<NotificationPermission | null>(null);

  const allow = async () => {
    const answer = await scheduler.requestPermission();
    last.current = answer;
    setPermission(answer);
    if (answer === "granted") requestReplan();
  };
  // Read on open and on every return to the app (the user may come back from iOS Settings); the first
  // read while undetermined shows the iOS prompt (designer #22.3).
  const permissionRead = useEffectEvent((state: NotificationPermission) => {
    const before = last.current;
    last.current = state;
    setPermission(state);
    if (state === "granted" && before !== null && before !== "granted") requestReplan();
    if (state === "undetermined" && !asked.current) {
      asked.current = true;
      void allow();
    }
  });
  useEffect(() => {
    const read = () => {
      scheduler.permission().then(permissionRead, () => undefined);
    };
    read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => subscription.remove();
  }, [scheduler]);

  const { deviceChanges: _, ...choices } = prefs;
  return {
    role: profile?.role ?? "owner",
    investments: invests,
    permission:
      permission === "undetermined"
        ? { kind: "undetermined", onAllow: allow }
        : permission === "denied"
          ? { kind: "denied", onOpenSettings: args.openSettings }
          : null,
    prefs: choices,
    // Titles may name the owner's bucket or carry amounts: shown made safe, as on the Signals list.
    markedAlerts:
      titles.length === 0
        ? null
        : titles.map((t) => safeText(t.text, { locale, privacy })).join(", "),
    // TRANSITIONAL(S44): no device registry on the phone before pairing.
    deviceChangesAvailable: false,
    // No synced consent end date yet (host secrets only): the row stays hidden.
    consentAvailable: false,
    weeklyTime: hourText(WEEKLY_HOUR, locale),
    eveningTime: hourText(EVENING_HOUR, locale),
    staleAfterHours: STALE_RUNGS_HOURS[0] ?? 36,
    consentDays: [CONSENT_RUNGS_DAYS[0] ?? 7, CONSENT_RUNGS_DAYS[1] ?? 1],
    onToggle: (choice, value) => {
      void write.run({ vault, prefs: { [choice]: value } });
    },
    preview: __DEV__
      ? {
          onPreview: async () => {
            if (
              (await scheduler.permission()) !== "granted" &&
              (await scheduler.requestPermission()) !== "granted"
            )
              return;
            const now = new Date();
            const digests = previewNotifications(
              {
                services,
                now,
                today: localToday(now),
                timeZone: deviceTimeZone(),
                lang: lang(),
                locale: intlLocale(),
              },
              vault,
              PREVIEW_DELAY_MS,
            );
            for (const digest of digests) await scheduler.schedule(digest);
          },
        }
      : null,
  };
}
