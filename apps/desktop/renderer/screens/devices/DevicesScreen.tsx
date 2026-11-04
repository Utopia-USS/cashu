import { PairingView } from "../pairing/PairingView.js";
import { usePairingScreen } from "../pairing/usePairingScreen.js";
import { DevicesView } from "./DevicesView.js";
import { useDevicesScreen } from "./useDevicesScreen.js";

export function DevicesScreen() {
  const devices = useDevicesScreen();
  const pairing = usePairingScreen();
  return (
    <div className="grid gap-6">
      <PairingView state={pairing} />
      <DevicesView state={devices} />
    </div>
  );
}
