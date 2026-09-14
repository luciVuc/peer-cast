import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { IllustratedMessage } from "../components/IllustratedMessage";
import { Spinner } from "../components/Spinner";
import { useAppDispatch } from "../store";
import { api } from "../store/api";

/**
 * Landing page for the email-change confirmation link. The server redirects
 * here with ?status= after consuming the token, so this page just reflects it.
 */
export function VerifyEmailChangePage() {
  const [params] = useSearchParams();
  const statusParam = params.get("status");
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (statusParam === "ok") {
      // Re-fetch /users/me so the stored email reflects the change.
      dispatch(api.util.invalidateTags(["Me"]));
    }
  }, [statusParam, dispatch]);

  if (!statusParam) return <Spinner label="Confirming your new email…" />;

  if (statusParam === "ok") {
    return (
      <IllustratedMessage
        icon="✅"
        title="Email updated!"
        description="Your new address is confirmed and now in use."
        action={
          <Link to="/settings" className="btn-primary">
            Back to settings
          </Link>
        }
      />
    );
  }

  if (statusParam === "taken") {
    return (
      <IllustratedMessage
        icon="⚠️"
        title="Email address already in use"
        description="That email is now tied to another account, so the change was not applied. Try a different address."
        action={
          <Link to="/settings" className="btn-primary">
            Back to settings
          </Link>
        }
      />
    );
  }

  return (
    <IllustratedMessage
      icon="⚠️"
      title="Invalid or expired link"
      description="The email-change confirmation link has expired or was already used."
      action={
        <Link to="/settings" className="btn-primary">
          Back to settings
        </Link>
      }
    />
  );
}
