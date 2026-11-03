import { attachModal } from "@cashu/ui-logic/core/modal";
import { type ReactNode, useEffect, useRef } from "react";

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
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => attachModal(panel.current, { onClose: () => close.current() }), []);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-overlay" aria-hidden="true" onClick={onClose} />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-auto border-l border-border bg-surface p-6 shadow-xl"
      >
        <div className="db">{children}</div>
      </aside>
    </>
  );
}
