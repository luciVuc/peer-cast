import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store";
import { loggedOut } from "../store/authSlice";
import { broadcastStopped } from "../store/broadcastSlice";
import { broadcastService } from "../lib/broadcastService";
import { useEndBroadcastMutation } from "../store/api";
import { Avatar } from "./Avatar";

export function Layout() {
  const user = useAppSelector((s) => s.auth.user);
  const broadcastStatus = useAppSelector((s) => s.broadcast.status);
  const activeBroadcast = useAppSelector((s) => s.broadcast.active);
  const [endBroadcast] = useEndBroadcastMutation();
  const isLive = broadcastStatus === "live" || broadcastStatus === "starting";
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(`/?q=${encodeURIComponent(term)}`);
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-white/5 bg-ink-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-bold">
            <span className="text-xl">📡</span>
            <span className="text-lg tracking-tight">PeerCast</span>
          </Link>

          <form onSubmit={onSearch} className="ml-2 hidden flex-1 sm:block">
            <input
              className="input max-w-md"
              placeholder="Search users and live broadcasts…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </form>

          <nav className="ml-auto flex items-center gap-2">
            {user ? (
              <>
                {isLive ? (
                  // Pulsing live indicator — always navigates to the broadcast
                  // management page so the user can stop the broadcast.
                  <NavLink
                    to="/broadcast"
                    className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500"
                  >
                    <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                    Live
                  </NavLink>
                ) : (
                  <NavLink
                    to="/broadcast"
                    className={({ isActive }) =>
                      `btn-ghost ${isActive ? "ring-1 ring-brand-500" : ""}`
                    }
                  >
                    Go live
                  </NavLink>
                )}
                <NavLink
                  to="/dashboard"
                  className={({ isActive }) =>
                    `hidden sm:inline-flex btn-ghost ${isActive ? "ring-1 ring-brand-500" : ""}`
                  }
                >
                  Dashboard
                </NavLink>
                {user.role === "admin" && (
                  <NavLink
                    to="/admin"
                    className={({ isActive }) =>
                      `hidden sm:inline-flex btn-ghost ${isActive ? "ring-1 ring-brand-500" : ""}`
                    }
                  >
                    Admin
                  </NavLink>
                )}
                <Link to="/dashboard" className="flex items-center">
                  <Avatar user={user} size={36} />
                </Link>
                <button
                  className="btn-ghost hidden sm:inline-flex"
                  onClick={() => {
                    // End any active broadcast (server-side) before signing
                    // out, then release the local host + media tracks.
                    const liveId = activeBroadcast?.broadcastId;
                    if (liveId) {
                      void endBroadcast(liveId)
                        .unwrap()
                        .catch(() => {
                          /* best-effort */
                        });
                    }
                    broadcastService.cleanup();
                    dispatch(broadcastStopped());
                    dispatch(loggedOut());
                    navigate("/");
                  }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className="btn-ghost">
                  Sign in
                </Link>
                <Link to="/register" className="btn-primary">
                  Register
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>

      <footer className="border-t border-white/5 py-6 text-center text-xs text-slate-500">
        PeerCast · peer-to-peer broadcasting · self-hosted
      </footer>
    </div>
  );
}
