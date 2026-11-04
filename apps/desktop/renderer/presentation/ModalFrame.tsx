import { Modal } from "@cashu/ui";
import type { ReactNode } from "react";

/** The desktop drawer's modal shell, shared by loading, failure and ready content. */
export function ModalFrame({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <Modal
      label={label}
      onClose={onClose}
      className="inset-y-0 right-0 left-auto w-full max-w-xl rounded-none border-l border-border bg-surface p-6 shadow-xl"
    >
      <div className="db">{children}</div>
    </Modal>
  );
}
