import { useProfile } from "@cashu/store-react";
import { PairingView } from "../pairing/PairingView.js";
import { usePairingScreen } from "../pairing/usePairingScreen.js";
import { DevicesView } from "./DevicesView.js";
import { useDevicesScreen } from "./useDevicesScreen.js";
import { useLeaderAction } from "./useLeaderAction.js";

export function DevicesScreen() {
  const vault = useProfile();
  return <ScopedDevicesScreen key={vault} />;
}

function ScopedDevicesScreen() {
  const devices = useDevicesScreen();
  const pairing = usePairingScreen();
  const leaderAction = useLeaderAction(devices.list?.kind === "ready" ? devices.list : null);
  return (
    <div className="grid gap-6">
      <PairingView state={pairing} />
      <DevicesView state={devices} leaderAction={leaderAction} />
    </div>
  );
}
