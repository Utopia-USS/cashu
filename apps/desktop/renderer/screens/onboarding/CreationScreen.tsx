import type { NativeCreationReady } from "@cashu/host-protocol";
import type { CreationBridge } from "../../creationBridge.js";
import { CreationView } from "./CreationView.js";
import { useCreationScreen } from "./useCreationScreen.js";

export interface CreationScreenProps {
  readonly mode: "first" | "additional";
  readonly bridge: CreationBridge | null;
  readonly onReady: (locator: NativeCreationReady) => Promise<boolean>;
  readonly onClosed?: () => void;
}

export function CreationScreen(props: CreationScreenProps) {
  return <CreationView state={useCreationScreen(props)} />;
}
