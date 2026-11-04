import type { NativeCreationReady } from "@cashu/host-protocol";
import type { CreationBridge } from "../../creationBridge.js";
import { CreationView } from "./CreationView.js";
import { useCreationScreen } from "./useCreationScreen.js";
import type { CreationWorkspacePort } from "./workspacePort.js";

export interface CreationScreenProps {
  readonly mode: "first" | "additional";
  readonly bridge: CreationBridge | null;
  readonly onReady: (locator: NativeCreationReady) => Promise<boolean>;
  readonly workspace?: CreationWorkspacePort;
  readonly onComplete?: (locator: NativeCreationReady) => Promise<void> | void;
  readonly onClosed?: () => void;
}

export function CreationScreen(props: CreationScreenProps) {
  return <CreationView state={useCreationScreen(props)} />;
}
