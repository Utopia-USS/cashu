/** Host notification policy. Platform submitters own protocol framing and OS evidence. */
import type {
  WorkerNotification,
  WorkerNotificationResult,
  WorkerNotifier,
} from "../worker/contracts.js";
import type { NotificationIntentLedger } from "./intentLedger.js";

export interface NotificationSubmission {
  readonly version: 1;
  readonly requestId: string;
  readonly locale: "pl" | "en";
  readonly kind: WorkerNotification["kind"];
  readonly intentToken: string;
}
export type SubmissionResult =
  | { readonly state: "accepted" }
  | { readonly state: "unknown" }
  | {
      /** This result must prove that platform submission never started. */
      readonly state: "rejected";
      readonly reason: "denied" | "pending" | "unavailable" | "invalid";
    };
export interface NotificationTransport {
  submit(frame: NotificationSubmission): Promise<SubmissionResult>;
}

/** Reservation is durable before transport invocation. Any thrown transport error is unknown. */
export function hostNotifier(
  ledger: NotificationIntentLedger,
  transport: NotificationTransport,
): WorkerNotifier {
  return {
    name: "cashu-native-v1",
    async send(notification): Promise<WorkerNotificationResult> {
      if (
        (notification.kind === "signal") !== (notification.signalId !== undefined) ||
        (notification.locale !== "pl" && notification.locale !== "en")
      )
        return { state: "rejected", reason: "invalid" };
      let intent: ReturnType<NotificationIntentLedger["reserve"]>;
      try {
        intent = ledger.reserve(notification);
      } catch {
        return { state: "rejected", reason: "unavailable" };
      }
      let result: SubmissionResult;
      try {
        result = await transport.submit({
          version: 1,
          requestId: intent.requestId,
          locale: notification.locale,
          kind: notification.kind,
          intentToken: intent.intentToken,
        });
      } catch {
        return { state: "unknown" };
      }
      if (result.state === "rejected") {
        try {
          ledger.revoke(intent.requestId, intent.intentToken);
        } catch {
          /* The exact queue release remains the caller's responsibility. */
        }
      }
      return result;
    },
  };
}
