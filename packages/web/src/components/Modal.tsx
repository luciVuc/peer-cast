import type { ReactNode } from "react";

/** A simple centered modal dialog with a backdrop. */
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
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            className="text-slate-400 hover:text-slate-200"
            onClick={onClose}
            aria-label="Close"
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
