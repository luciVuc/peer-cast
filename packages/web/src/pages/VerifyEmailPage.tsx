import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { IllustratedMessage } from "../components/IllustratedMessage";
import { Spinner } from "../components/Spinner";
import { useAppDispatch, useAppSelector } from "../store";
import { addToast } from "../store/toastSlice";
import { useSendVerificationMutation } from "../store/api";
import { api } from "../store/api";

type Status = "pending" | "ok" | "invalid" | "resending";

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const statusParam = params.get("status");
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.auth.user);
  const [sendVerification] = useSendVerificationMutation();
  const [status, setStatus] = useState<Status>(() => {
    if (statusParam === "ok") return "ok";
    if (statusParam === "invalid") return "invalid";
    return "pending";
  });

  // If the server redirected here with ?status= (after consuming the token),
  // we just reflect that status. If we have a raw token in the URL, the
  // server-side redirect should have happened — this is just a fallback.
  useEffect(() => {
    if (statusParam === "ok") {
      // Invalidate /users/me so the header re-fetches the verified state.
      dispatch(api.util.invalidateTags(["Me"]));
    }
  }, [statusParam, dispatch]);

  async function resend() {
    if (!user) return;
    setStatus("resending");
    try {
      await sendVerification().unwrap();
      dispatch(
        addToast("Verification email sent! Check your inbox.", "success"),
      );
      setStatus("pending");
    } catch {
      dispatch(addToast("Could not send email. Try again later.", "error"));
      setStatus("pending");
    }
  }

  if (!statusParam && !token) {
    // Arrived without any params — probably direct nav; show resend UI.
    if (!user)
      return (
        <IllustratedMessage
          icon="🔒"
          title="Sign in first"
          action={
            <Link to="/login" className="btn-primary">
              Sign in
            </Link>
          }
        />
      );
    if (user.emailVerified) {
      return (
        <IllustratedMessage
          icon="✅"
          title="Email already verified"
          description="Your email address is confirmed."
          action={
            <Link to="/dashboard" className="btn-primary">
              Go to dashboard
            </Link>
          }
        />
      );
    }
    return (
      <div className="mx-auto max-w-md">
        <div className="card p-8 text-center">
          <div className="mb-4 text-4xl">📧</div>
          <h1 className="mb-2 text-xl font-bold">Verify your email</h1>
          <p className="mb-6 text-sm text-slate-400">
            We sent a verification link to <strong>{user.email}</strong>. Check
            your inbox and click the link to confirm your address.
          </p>
          <button
            className="btn-primary"
            onClick={resend}
            disabled={status === "resending"}
          >
            {status === "resending" ? "Sending…" : "Resend email"}
          </button>
        </div>
      </div>
    );
  }

  if (status === "pending") return <Spinner label="Verifying your email…" />;

  if (status === "ok") {
    return (
      <IllustratedMessage
        icon="✅"
        title="Email verified!"
        description="Your address is confirmed. You're all set."
        action={
          <Link to="/dashboard" className="btn-primary">
            Go to dashboard
          </Link>
        }
      />
    );
  }

  return (
    <IllustratedMessage
      icon="⚠️"
      title="Invalid or expired link"
      description="The verification link has expired or was already used."
      action={
        user ? (
          <button className="btn-primary" onClick={resend}>
            Send a new link
          </button>
        ) : (
          <Link to="/login" className="btn-primary">
            Sign in to request a new link
          </Link>
        )
      }
    />
  );
}
