import { useState } from "react";
import { Link } from "react-router-dom";
import { useForgotPasswordMutation } from "../store/api";
import { useAppDispatch } from "../store";
import { addToast } from "../store/toastSlice";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [forgot, { isLoading }] = useForgotPasswordMutation();
  const dispatch = useAppDispatch();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await forgot({ email }).unwrap();
    } catch {
      /* server always 200s to avoid email enumeration; swallow any error */
    }
    setSubmitted(true);
    dispatch(
      addToast(
        "If that email is registered, a reset link is on its way.",
        "info",
        8000,
      ),
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="card p-8">
        <h1 className="mb-2 text-2xl font-bold">Forgot password?</h1>
        <p className="mb-6 text-sm text-slate-400">
          Enter your email and we'll send a link to reset your password.
        </p>

        {submitted ? (
          <div className="space-y-4 text-center">
            <div className="text-4xl">📬</div>
            <p className="text-sm text-slate-300">
              Check your inbox for a password-reset link. It expires in 1 hour.
            </p>
            <p className="text-sm text-slate-500">
              Didn't receive it? Check your spam folder, or{" "}
              <button
                className="text-brand-400 hover:underline"
                onClick={() => setSubmitted(false)}
              >
                try again
              </button>
              .
            </p>
            <Link to="/login" className="btn-ghost inline-flex">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">Email address</label>
              <input
                className="input"
                type="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <button
              className="btn-primary w-full"
              disabled={isLoading || !email}
            >
              {isLoading ? "Sending…" : "Send reset link"}
            </button>
            <p className="text-center text-sm text-slate-400">
              Remembered it?{" "}
              <Link to="/login" className="text-brand-400 hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
