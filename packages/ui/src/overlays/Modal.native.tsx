import { BottomSheet, Host, Text } from "@expo/ui";
import type { ModalProps } from "./Modal.types.js";

/** Native modal sheet with platform dismissal and back handling. */
export function Modal({ label, onClose, children }: ModalProps) {
  return (
    <Host>
      <BottomSheet isPresented onDismiss={onClose} snapPoints={["full"]}>
        <Text>{label}</Text>
        {children}
      </BottomSheet>
    </Host>
  );
}
