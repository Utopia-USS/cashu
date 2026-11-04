import type { KeyboardEventHandler, ReactNode, Ref } from "react";

export interface ModalProps {
  label: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
  panelRef?: Ref<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  focus?: "first" | "panel";
}
