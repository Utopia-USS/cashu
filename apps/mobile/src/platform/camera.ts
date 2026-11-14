// The camera for the pairing scan (expo-camera): the permission as the pairing flow reads it, asked once
// the scan step is on screen (iOS shows its prompt over whatever is drawn, so asking earlier leaves a
// blank modal behind it). A denied camera makes "Paste the code" the way in (dev-feedback #23.8). The
// scanner itself is expo-camera's `CameraView`, rendered by the pairing View with `QR_ONLY`.
import { type BarcodeSettings, useCameraPermissions } from "expo-camera";
import { useEffect, useEffectEvent, useRef } from "react";

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
  const [permission, request] = useCameraPermissions();
  const asked = useRef(false);
  const answer = useEffectEvent(onAnswer);
  useEffect(() => {
    if (permission === null) return;
    if (permission.granted) answer("granted");
    else if (permission.canAskAgain && !asked.current) {
      if (!ready) return;
      asked.current = true;
      void request();
    } else answer("denied");
  }, [permission, request, ready]);
}
