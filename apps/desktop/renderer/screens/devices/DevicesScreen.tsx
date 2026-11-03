import { DevicesView } from "./DevicesView.js";
import { useDevicesScreen } from "./useDevicesScreen.js";

export function DevicesScreen() {
  return <DevicesView state={useDevicesScreen()} />;
}
