import { SetupView } from "./SetupView.js";
import { type SetupScreenProps, useSetupScreen } from "./useSetupScreen.js";

export function SetupScreen(props: SetupScreenProps) {
  return <SetupView state={useSetupScreen(props)} />;
}
