import { useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../store";
import { loggedOut } from "../store/authSlice";
import { broadcastStopped } from "../store/broadcastSlice";
import { broadcastService } from "../lib/broadcastService";
import { useEndBroadcastMutation, useGetConfigQuery } from "../store/api";
import { Avatar } from "./Avatar";

function DrawerLink({
  to,
  children,
  onClose,
}: {
  to: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onClose}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-ink-600 focus:outline-none focus:ring-2 focus:ring-brand-500/60"
    >
      {children}
    </Link>
  );
}

function DrawerButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-200 transition hover:bg-ink-600 focus:outline-none focus:ring-2 focus:ring-brand-500/60"
    >
      {children}
    </button>
  );
}

export function Layout() {
  const user = useAppSelector((s) => s.auth.user);
  const broadcastStatus = useAppSelector((s) => s.broadcast.status);
  const activeBroadcast = useAppSelector((s) => s.broadcast.active);
  const [endBroadcast] = useEndBroadcastMutation();
  const { data: appConfig } = useGetConfigQuery();
  const isLive = broadcastStatus === "live" || broadcastStatus === "starting";
  const dispatch = useAppDispatch();
  const location = useLocation();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [drawerQ, setDrawerQ] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // Close drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Focus the close button when the drawer opens for accessibility
  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
  }, [drawerOpen]);

  // Lock body scroll while drawer is open
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [drawerOpen]);

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (term) {
      setDrawerOpen(false);
      navigate(`/?q=${encodeURIComponent(term)}`);
    }
  }

  function onDrawerSearch(e: React.FormEvent) {
    e.preventDefault();
    const term = drawerQ.trim();
    if (term) {
      setDrawerOpen(false);
      navigate(`/?q=${encodeURIComponent(term)}`);
    }
  }

  function signOut() {
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
    setDrawerOpen(false);
    navigate("/");
  }

  async function checkForUpdate() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const response = await fetch(`/api/config?check=${Date.now()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("version check failed");
      const latest = (await response.json()) as { version?: string };
      const currentVersion = appConfig?.version;
      if (
        !latest.version ||
        !currentVersion ||
        latest.version === currentVersion
      ) {
        await navigator.serviceWorker
          ?.getRegistration()
          ?.then((registration) => registration?.update());
        window.alert(
          `PeerCast ${currentVersion ?? latest.version ?? ""} is up to date.`,
        );
        return;
      }

      const shouldUpdate = window.confirm(
        `PeerCast ${latest.version} is available (you have ${currentVersion}). Update now?`,
      );
      if (!shouldUpdate) return;

      await navigator.serviceWorker
        ?.getRegistration()
        ?.then((registration) => registration?.update());
      window.location.reload();
    } catch {
      window.alert("Unable to check for updates right now.");
    } finally {
      setCheckingUpdate(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-white/5 bg-ink-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          {/* Mobile hamburger */}
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-300 transition hover:bg-ink-700 focus:outline-none focus:ring-2 focus:ring-brand-500/60 sm:hidden"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              className="h-5 w-5"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <Link to="/" className="flex items-center gap-2 font-bold">
            <span className="text-xl">📡</span>
            <span className="text-lg tracking-tight">PeerCast</span>
          </Link>

          {/* Desktop search */}
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
                  <NavLink
                    to="/broadcast"
                    className="flex min-h-11 items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500"
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
                {/* Desktop: show full nav */}
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
                  onClick={signOut}
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

      {/* ─── Mobile drawer ────────────────────────────────────────────────── */}
      {user && drawerOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm sm:hidden"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          {/* Drawer panel */}
          <div
            role="dialog"
            aria-label="Menu"
            aria-modal="true"
            className="fixed inset-y-0 right-0 z-40 flex w-72 flex-col bg-ink-900 shadow-2xl shadow-black/40 sm:hidden"
          >
            {/* Drawer header: close button + user info */}
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
              {user && (
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar user={user} size={44} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {user.displayName}
                    </div>
                    <div className="truncate text-xs text-slate-400">
                      @{user.username}
                    </div>
                  </div>
                </div>
              )}
              <button
                ref={closeRef}
                type="button"
                aria-label="Close menu"
                onClick={() => setDrawerOpen(false)}
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-ink-700 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500/60"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  className="h-5 w-5"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Drawer body: search + nav links */}
            <div className="flex-1 overflow-y-auto px-3 py-4">
              <form onSubmit={onDrawerSearch} className="mb-4">
                <input
                  className="input"
                  placeholder="Search users and broadcasts…"
                  value={drawerQ}
                  onChange={(e) => setDrawerQ(e.target.value)}
                />
              </form>

              <div className="space-y-1">
                <DrawerLink
                  to="/dashboard"
                  onClose={() => setDrawerOpen(false)}
                >
                  Dashboard
                </DrawerLink>
                {user.role === "admin" && (
                  <DrawerLink to="/admin" onClose={() => setDrawerOpen(false)}>
                    Admin
                  </DrawerLink>
                )}
              </div>

              <div className="my-4 border-t border-white/5" />

              <DrawerButton onClick={signOut}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4 text-slate-500"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Sign out
              </DrawerButton>
            </div>
          </div>
        </>
      )}

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>

      <footer className="border-t border-white/5 py-6 text-center text-xs text-slate-500">
        PeerCast · peer-to-peer broadcasting ·{" "}
        <button
          type="button"
          className="underline decoration-dotted underline-offset-2 transition hover:text-slate-300 disabled:cursor-wait"
          onClick={() => void checkForUpdate()}
          disabled={checkingUpdate}
          title="Check for a newer PeerCast version"
        >
          {checkingUpdate
            ? "checking for updates…"
            : `v${appConfig?.version ?? "…"}`}
        </button>
      </footer>
    </div>
  );
}
