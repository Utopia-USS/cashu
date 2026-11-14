// The camera for the pairing scan (expo-camera): the permission as the pairing flow reads it, asked once
// the scan step is on screen (iOS shows its prompt over whatever is drawn, so asking earlier leaves a
// blank modal behind it). While the prompt is up the app is inactive by its own doing, so the app-switcher
// cover stays away (`systemPrompt`). The permission is read again each time the app becomes active: the
// answer to a prompt (or a change in Settings) is heard even when the request's own result is lost. A
// denied camera makes "Paste the code" the way in (dev-feedback #23.8). The scanner itself is expo-camera's
// `CameraView`, rendered by the pairing View with `QR_ONLY`.
import { type BarcodeSettings, useCameraPermissions } from "expo-camera";
import { useEffect, useEffectEvent, useRef } from "react";
import { AppState } from "react-native";
import { systemPrompt } from "../shell/systemPrompt";

/** Only QR codes: the Mac's invitation is one. */
export const QR_ONLY: BarcodeSettings = { barcodeTypes: ["qr"] };

/**
 * The camera permission: reports granted / denied; when it was never answered, asks once, and only
 * after `ready` (the screen behind the prompt has drawn).
 */
export function useCameraAccess(
  onAnswer: (access: "granted" | "denied") => void,
  ready: boolean,
): void {
  const [permission, request, get] = useCameraPermissions();
  const asked = useRef(false);
  const answer = useEffectEvent(onAnswer);
  const reread = useEffectEvent(() => void get());
  useEffect(() => {
    if (permission === null) return;
    // expo's status enum holds these strings.
    const status: string = permission.status;
    if (permission.granted) answer("granted");
    else if (permission.canAskAgain && !asked.current) {
      if (!ready) return;
      asked.current = true;
      const answered = systemPrompt.expect();
      void request().finally(answered);
      // Asked and not answered yet (the prompt is up): the answer comes as a new permission.
    } else if (!permission.canAskAgain || status !== "undetermined") answer("denied");
  }, [permission, request, ready]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") reread();
    });
    return () => subscription.remove();
  }, []);
}
