import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PASSWORD_MIN, USERNAME_RE } from "@peer-cast/shared";
import { useGetConfigQuery, useRegisterMutation } from "../store/api";
import { useAppDispatch } from "../store";
import { loggedIn } from "../store/authSlice";
import { addToast, errorMessage } from "../store/toastSlice";
import { IllustratedMessage } from "../components/IllustratedMessage";

export function RegisterPage() {
  const { data: cfg } = useGetConfigQuery();
  const [form, setForm] = useState({
    displayName: "",
    username: "",
    email: "",
    password: "",
    about: "",
    inviteCode: "",
    adminBootstrapSecret: "",
  });
  const [register, { isLoading }] = useRegisterMutation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  const usernameOk = USERNAME_RE.test(form.username);
  const passwordOk = form.password.length >= PASSWORD_MIN;
  const mode = cfg?.registration ?? "open";
  const inviteOk = mode !== "invite" || form.inviteCode.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await register({
        displayName: form.displayName,
        username: form.username,
        email: form.email,
        password: form.password,
        about: form.about || null,
        inviteCode:
          mode === "invite" ? form.inviteCode.trim() || undefined : undefined,
        adminBootstrapSecret: form.adminBootstrapSecret.trim() || undefined,
      }).unwrap();
      dispatch(loggedIn(res));
      dispatch(
        addToast(
          "Account created! Check your email to verify your address.",
          "success",
        ),
      );
      navigate("/dashboard", { replace: true });
    } catch (err) {
      dispatch(addToast(errorMessage(err, "Registration failed"), "error"));
    }
  }

  if (mode === "closed" && !cfg?.adminBootstrap) {
    return (
      <IllustratedMessage
        icon="🔒"
        title="Registration is closed"
        description="This PeerCast server isn't accepting new accounts right now."
        action={
          <Link to="/login" className="btn-primary">
            Sign in
          </Link>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="card p-8">
        <h1 className="mb-6 text-2xl font-bold">Create your account</h1>
        {mode === "closed" && (
          <p className="mb-4 text-sm text-slate-400">
            Registration is closed for regular accounts. The operator can
            bootstrap the configured administrator with the private secret.
          </p>
        )}
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Display name</label>
            <input
              id="reg-displayName"
              className="input"
              value={form.displayName}
              onChange={(e) => set("displayName", e.target.value)}
            />
          </div>
          <div>
            <label className="label">Username</label>
            <input
              id="reg-username"
              className="input"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder="3–30 chars: letters, digits, _ or -"
            />
            {form.username && !usernameOk && (
              <p className="mt-1 text-xs text-red-400">
                Invalid username format.
              </p>
            )}
          </div>
          <div>
            <label className="label">Email</label>
            <input
              id="reg-email"
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              id="reg-password"
              className="input"
              type="password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              autoComplete="new-password"
            />
            {form.password && !passwordOk && (
              <p className="mt-1 text-xs text-red-400">
                At least {PASSWORD_MIN} characters.
              </p>
            )}
          </div>
          <div>
            <label className="label">About (optional)</label>
            <textarea
              className="input"
              rows={2}
              value={form.about}
              onChange={(e) => set("about", e.target.value)}
            />
          </div>
          {mode === "invite" && (
            <div>
              <label className="label">Invite code</label>
              <input
                id="reg-invite"
                className="input"
                value={form.inviteCode}
                onChange={(e) => set("inviteCode", e.target.value)}
                placeholder="Required on this server"
              />
            </div>
          )}
          <div>
            <label className="label">Admin bootstrap secret (optional)</label>
            <input
              id="reg-adminBootstrapSecret"
              className="input"
              type="password"
              value={form.adminBootstrapSecret}
              onChange={(e) => set("adminBootstrapSecret", e.target.value)}
              autoComplete="off"
              placeholder="Only needed for the configured admin handle"
            />
            <p className="mt-1 text-xs text-slate-400">
              Leave blank for a regular account.
            </p>
          </div>
          <button
            className="btn-primary w-full"
            disabled={isLoading || !usernameOk || !passwordOk || !inviteOk}
          >
            {isLoading ? "Creating…" : "Create account"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-400">
          Already registered?{" "}
          <Link to="/login" className="text-brand-400 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
