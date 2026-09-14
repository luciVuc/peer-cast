import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PASSWORD_MIN } from "@peer-cast/shared";
import { useResetPasswordMutation } from "../store/api";
import { useAppDispatch } from "../store";
import { addToast, errorMessage } from "../store/toastSlice";
import { IllustratedMessage } from "../components/IllustratedMessage";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [resetPassword, { isLoading }] = useResetPasswordMutation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const valid = password.length >= PASSWORD_MIN && password === confirm;

  if (!token) {
    return (
      <IllustratedMessage
        icon="🔑"
        title="Missing reset token"
        description="Use the link from your password-reset email."
        action={
          <Link to="/forgot-password" className="btn-primary">
            Request a new link
          </Link>
        }
      />
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    try {
      await resetPassword({ token, newPassword: password }).unwrap();
      dispatch(addToast("Password updated — you can now sign in.", "success"));
      navigate("/login", { replace: true });
    } catch (err) {
      const code = (err as { data?: { code?: string } }).data?.code;
      if (code === "TOKEN_INVALID") {
        dispatch(
          addToast(
            "This reset link has expired or already been used. Request a new one.",
            "error",
            0,
          ),
        );
      } else {
        dispatch(
          addToast(errorMessage(err, "Could not reset password"), "error"),
        );
      }
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="card p-8">
        <h1 className="mb-2 text-2xl font-bold">Set new password</h1>
        <p className="mb-6 text-sm text-slate-400">
          Choose a strong password with at least {PASSWORD_MIN} characters.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">New password</label>
            <input
              className="input"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            {password && password.length < PASSWORD_MIN && (
              <p className="mt-1 text-xs text-red-400">
                At least {PASSWORD_MIN} characters.
              </p>
            )}
          </div>
          <div>
            <label className="label">Confirm password</label>
            <input
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
            {confirm && password !== confirm && (
              <p className="mt-1 text-xs text-red-400">
                Passwords don't match.
              </p>
            )}
          </div>
          <button className="btn-primary w-full" disabled={isLoading || !valid}>
            {isLoading ? "Saving…" : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}
