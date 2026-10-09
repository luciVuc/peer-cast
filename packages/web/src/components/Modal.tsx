import { type ReactNode, useEffect, useRef } from "react";

/** A simple centered modal dialog with a backdrop.
 *
 * Accessibility:
 *  - Traps focus inside the dialog (Tab / Shift+Tab cycle within it).
 *  - Restores focus to the trigger element on close.
 *  - Closes on Escape keypress.
 *  - Locks background scroll while open.
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

  // Escape to close, plus a real focus trap.
  //
  // The previous implementation only moved focus *into* the dialog once on
  // open; nothing intercepted Tab, so a keyboard user tabbed straight out of
  // the dialog into the page behind (still in the tab order and not `inert`),
  // landing on background controls like "End broadcast" with no visual context.
  // Cycle focus between the first and last focusable elements instead.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (
        e.shiftKey &&
        (active === first || !dialogRef.current?.contains(active))
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Lock background scroll while the dialog is open, matching the drawer.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

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
