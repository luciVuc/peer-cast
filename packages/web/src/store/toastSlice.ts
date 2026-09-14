import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  /** ms before auto-dismiss; 0 = sticky */
  duration: number;
}

export interface ToastState {
  toasts: Toast[];
}

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  error: 6000,
  info: 4000,
  warning: 5000,
};

let counter = 0;

const toastSlice = createSlice({
  name: "toast",
  initialState: { toasts: [] } as ToastState,
  reducers: {
    addToast: {
      prepare(
        message: string,
        variant: ToastVariant = "info",
        duration?: number,
      ) {
        return {
          payload: {
            id: `toast-${++counter}`,
            message,
            variant,
            duration: duration ?? DEFAULT_DURATION[variant],
          } satisfies Toast,
        };
      },
      reducer(state, action: PayloadAction<Toast>) {
        state.toasts.push(action.payload);
      },
    },
    dismissToast(state, action: PayloadAction<string>) {
      state.toasts = state.toasts.filter((t) => t.id !== action.payload);
    },
    clearToasts(state) {
      state.toasts = [];
    },
  },
});

export const { addToast, dismissToast, clearToasts } = toastSlice.actions;
export default toastSlice.reducer;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a human-readable message from an RTK Query error or Error. */
export function errorMessage(
  err: unknown,
  fallback = "Something went wrong",
): string {
  if (typeof err === "string") return err;
  const e = err as {
    data?: { error?: string };
    message?: string;
    error?: string;
  };
  return e?.data?.error ?? e?.message ?? e?.error ?? fallback;
}
