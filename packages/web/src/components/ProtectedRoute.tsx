import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Spinner } from "./Spinner";
import { useAppSelector } from "../store";

/**
 * Gate routes that require authentication.
 *
 * While the app is hydrating (boot-time refresh in flight), show a spinner so
 * we don't flash a /login redirect at a returning user whose cookie is still valid.
 */
export function ProtectedRoute() {
  const token = useAppSelector((s) => s.auth.accessToken);
  const hydrated = useAppSelector((s) => s.auth.hydrated);
  const location = useLocation();

  if (!hydrated) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Restoring session…" />
      </div>
    );
  }
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <Outlet />;
}
