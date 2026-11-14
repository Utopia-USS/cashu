import type { StartupFailureReport } from "@cashu/host-protocol/startup-failure";
import type { RecoveryBridge } from "../recoveryBridge.js";
import { RecoveryView } from "./RecoveryView.js";
import { useRecoveryScreen } from "./useRecoveryScreen.js";

/** The start-up recovery screen (`?recovery=1`), rendered before and without any host connection. */
export function RecoveryScreen({
  report,
  bridge,
}: {
  report: StartupFailureReport | null;
  bridge: RecoveryBridge | null;
}) {
  return <RecoveryView {...useRecoveryScreen(report, bridge)} />;
}
