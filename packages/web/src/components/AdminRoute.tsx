import { Navigate, Outlet } from "react-router-dom";
import { Spinner } from "./Spinner";
import { useAppSelector } from "../store";

/** Gate routes to signed-in admins; show a spinner during hydration. */
export function AdminRoute() {
  const user = useAppSelector((s) => s.auth.user);
  const hydrated = useAppSelector((s) => s.auth.hydrated);

  if (!hydrated) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Restoring session…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return <Outlet />;
}
