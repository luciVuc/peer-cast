import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useLoginMutation } from "../store/api";
import { useAppDispatch } from "../store";
import { loggedIn } from "../store/authSlice";
import { addToast, errorMessage } from "../store/toastSlice";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [login, { isLoading }] = useLoginMutation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname: string } } };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await login({ username, password }).unwrap();
      dispatch(loggedIn(res));
      navigate(location.state?.from?.pathname ?? "/dashboard", {
        replace: true,
      });
    } catch (err) {
      dispatch(addToast(errorMessage(err, "Sign in failed"), "error"));
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="card p-8">
        <h1 className="mb-6 text-2xl font-bold">Sign in</h1>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Username</label>
            <input
              className="input"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <button className="btn-primary w-full" disabled={isLoading}>
            {isLoading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="mt-4 flex flex-col gap-1 text-center text-sm text-slate-400">
          <span>
            No account?{" "}
            <Link to="/register" className="text-brand-400 hover:underline">
              Register
            </Link>
          </span>
          <span>
            Forgot password?{" "}
            <Link
              to="/forgot-password"
              className="text-brand-400 hover:underline"
            >
              Reset it
            </Link>
          </span>
        </div>
      </div>
    </div>
  );
}
