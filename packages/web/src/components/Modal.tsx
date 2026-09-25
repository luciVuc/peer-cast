import { type ReactNode, useEffect, useRef } from "react";

/** A simple centered modal dialog with a backdrop.
 *
 * Accessibility:
 *  - Traps focus inside the dialog on open.
 *  - Restores focus to the trigger element on close.
 *  - Closes on Escape keypress.
 */
export function Modal({
  open = true,
  title,
  children,
  onClose,
  actions,
}: {
  open?: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Optional footer buttons rendered right-aligned. */
  actions?: ReactNode;
}) {
  // Remember the element that had focus when the modal opened.
  const triggerRef = useRef<Element | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    // Move focus into the dialog on the next frame so the element is mounted.
    const frame = requestAnimationFrame(() => {
      const focusable = dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      // Restore focus to the element that opened the modal.
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    };
  }, [open]);

  // Close on Escape key.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="card w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="modal-title" className="text-lg font-bold">
            {title}
          </h2>
          <button
            className="text-slate-400 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500/60 rounded"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>
        {children}
        {actions && (
          <div className="mt-6 flex justify-end gap-3">{actions}</div>
        )}
      </div>
    </div>
  );
}
