// The phone's sync in the running app (mounted once by the root layout next to the notifications;
// renders nothing): the triggers of `usePhoneSync`.
import { usePhoneSync } from "./usePhoneSync";

export function PhoneSync() {
  usePhoneSync();
  return null;
}
