import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "../store";
import { dismissToast, type ToastVariant } from "../store/toastSlice";

const ICONS: Record<ToastVariant, string> = {
  success: "✓",
  error: "✕",
  info: "ℹ",
  warning: "⚠",
};

const COLORS: Record<ToastVariant, string> = {
  success: "border-emerald-500/50 bg-emerald-900/80 text-emerald-100",
  error: "border-red-500/50 bg-red-900/80 text-red-100",
  info: "border-brand-500/50 bg-brand-900/80 text-brand-100",
  warning: "border-amber-500/50 bg-amber-900/80 text-amber-100",
};

const ICON_COLORS: Record<ToastVariant, string> = {
  success: "text-emerald-400",
  error: "text-red-400",
  info: "text-brand-400",
  warning: "text-amber-400",
};

function ToastItem({
  id,
  message,
  variant,
  duration,
}: {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!duration) return;
    const t = setTimeout(() => dispatch(dismissToast(id)), duration);
    return () => clearTimeout(t);
  }, [id, duration, dispatch]);

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg shadow-black/30 backdrop-blur transition-all ${COLORS[variant]}`}
    >
      <span className={`mt-0.5 shrink-0 font-bold ${ICON_COLORS[variant]}`}>
        {ICONS[variant]}
      </span>
      <p className="flex-1 text-sm leading-snug">{message}</p>
      <button
        className="shrink-0 opacity-60 hover:opacity-100"
        onClick={() => dispatch(dismissToast(id))}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

/** Render all active toasts in a fixed bottom-right tray. */
export function Toasts() {
  const toasts = useAppSelector((s) => s.toast.toasts);
  if (!toasts.length) return null;
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} {...t} />
      ))}
    </div>
  );
}
