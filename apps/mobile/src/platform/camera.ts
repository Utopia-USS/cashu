// The camera for the pairing scan (expo-camera): the permission as the pairing flow reads it, asked once
// when the scan step opens. A denied camera makes "Paste the code" the way in (dev-feedback #23.8). The
// scanner itself is expo-camera's `CameraView`, rendered by the pairing View with `QR_ONLY`.
import { type BarcodeSettings, useCameraPermissions } from "expo-camera";
import { useEffect, useEffectEvent, useRef } from "react";

/** Only QR codes: the Mac's invitation is one. */
export const QR_ONLY: BarcodeSettings = { barcodeTypes: ["qr"] };

/** The camera permission: asks once when it was never answered; reports granted / denied. */
export function useCameraAccess(onAnswer: (access: "granted" | "denied") => void): void {
  const [permission, request] = useCameraPermissions();
  const asked = useRef(false);
  const answer = useEffectEvent(onAnswer);
  useEffect(() => {
    if (permission === null) return;
    if (permission.granted) answer("granted");
    else if (permission.canAskAgain && !asked.current) {
      asked.current = true;
      void request();
    } else answer("denied");
  }, [permission, request]);
}
