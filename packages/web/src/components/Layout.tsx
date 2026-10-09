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
import { useEndBroadcastMutation, useGetConfigQuery, api } from "../store/api";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import { addToast } from "../store/toastSlice";

function DrawerLink({
  to,
  children,
  onClose,
  className = "",
}: {
  to: string;
  children: React.ReactNode;
  onClose: () => void;
  /** Extra classes appended to the shared row styling. */
  className?: string;
}) {
  return (
    <Link
      to={to}
      onClick={onClose}
      className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-ink-600 focus:outline-none focus:ring-2 focus:ring-brand-500/60 ${className}`}
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
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [drawerQ, setDrawerQ] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  // Pending "an update is available" confirmation, rendered as a Modal.
  const [updatePrompt, setUpdatePrompt] = useState<{
    latest: string;
    current: string;
  } | null>(null);

  async function applyUpdate() {
    setUpdatePrompt(null);
    await navigator.serviceWorker
      ?.getRegistration()
      ?.then((registration) => registration?.update());
    window.location.reload();
  }

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

  // Escape closes the drawer. The drawer is an aria-modal dialog, so it has to
  // behave like one — this was previously only closable via the backdrop or the
  // close button, and it was unreachable for signed-out users anyway.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
    // Drop every cached API response owned by the previous session before the
    // next login, otherwise RTK Query can keep serving the old user's profile
    // and poison derived state (e.g. the broadcast viewer link).
    dispatch(api.util.resetApiState());
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
        dispatch(
          addToast(
            `PeerCast ${currentVersion ?? latest.version ?? ""} is up to date.`,
            "success",
          ),
        );
        return;
      }

      // A Modal + toast rather than window.confirm/alert: blocking dialogs break
      // PWA standalone mode, cannot be styled, and in some embedded contexts
      // cannot be dismissed from the keyboard.
      setUpdatePrompt({
        latest: latest.version,
        current: currentVersion ?? "?",
      });
      return;

      await navigator.serviceWorker
        ?.getRegistration()
        ?.then((registration) => registration?.update());
      window.location.reload();
    } catch {
      dispatch(addToast("Unable to check for updates right now.", "error"));
    } finally {
      setCheckingUpdate(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Skip-to-content link for keyboard/screen-reader users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50
                   focus:rounded focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-white/5 bg-ink-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-bold">
            <span className="text-xl">📡</span>
            <span className="text-lg tracking-tight">PeerCast</span>
          </Link>

          {/*
            Desktop search. Starts at `lg`, not `sm`: between sm and lg the full
            inline nav (Go live / Dashboard / Admin / avatar / Sign out) is on
            screen, and a `flex-1` input in that row absorbs every pixel of
            slack and collapses to an unusable sliver. Below lg the search icon
            is shown instead, which is what mobile already used.
          */}
          <form
            onSubmit={onSearch}
            className="ml-2 hidden min-w-0 flex-1 lg:block"
          >
            <input
              className="input max-w-md"
              placeholder="Search users and live broadcasts…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </form>

          <nav className="ml-auto flex items-center gap-2">
            {/* Mobile search icon — visible to all users on small screens */}
            <button
              type="button"
              aria-label={mobileSearchOpen ? "Close search" : "Search"}
              onClick={() => setMobileSearchOpen((o) => !o)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-300 transition hover:bg-ink-700 focus:outline-none focus:ring-2 focus:ring-brand-500/60 lg:hidden"
            >
              {mobileSearchOpen ? (
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
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  className="h-5 w-5"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
              )}
            </button>
            {user ? (
              <>
                {isLive ? (
                  // While live this stays visible at every width: it is status
                  // feedback a broadcaster needs at a glance, not just a link,
                  // so hiding it behind the burger would be the wrong trade.
                  // `whitespace-nowrap` keeps it on one line at 320px.
                  <NavLink
                    to="/broadcast"
                    aria-label="Manage your live broadcast"
                    className="flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500"
                  >
                    <span
                      className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-white"
                      aria-hidden="true"
                    />
                    Live
                  </NavLink>
                ) : (
                  // Idle "Go live" is a primary *action*, and it is reachable
                  // from the dashboard and the drawer, so it collapses below
                  // `sm` with the rest of the navigation. At 320px it was
                  // forcing the bar to overflow and wrapping onto two lines.
                  <NavLink
                    to="/broadcast"
                    aria-label="Start a broadcast"
                    className={({ isActive }) =>
                      `btn-ghost hidden whitespace-nowrap sm:inline-flex ${isActive ? "ring-1 ring-brand-500" : ""}`
                    }
                  >
                    Go live
                  </NavLink>
                )}
                {/* Desktop: show full nav */}
                <NavLink
                  to="/dashboard"
                  className={({ isActive }) =>
                    `hidden whitespace-nowrap sm:inline-flex btn-ghost ${isActive ? "ring-1 ring-brand-500" : ""}`
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
                {/* The avatar is the account menu entry point. It has no
                 * visible text, so it needs an explicit accessible name — a
                 * bare initials image announces as "AJ, link", which tells a
                 * screen-reader user nothing about where it goes. */}
                <Link
                  to="/dashboard"
                  aria-label={`Your account (${user.displayName})`}
                  className="flex shrink-0 items-center"
                >
                  <Avatar user={user} size={36} />
                </Link>
                <button
                  className="btn-ghost hidden whitespace-nowrap sm:inline-flex"
                  onClick={signOut}
                >
                  Sign out
                </button>
              </>
            ) : (
              /* Hidden below `sm`: on a phone these two buttons plus the logo
               * plus the burger crowd the top bar, and both destinations are in
               * the drawer (see the signed-out branch there). Still rendered,
               * just not shown, so there is no second copy in the DOM. */
              <>
                <Link to="/login" className="btn-ghost hidden sm:inline-flex">
                  Sign in
                </Link>
                <Link
                  to="/register"
                  className="btn-primary hidden sm:inline-flex"
                >
                  Register
                </Link>
              </>
            )}

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
          </nav>
        </div>
      </header>

      {/* Mobile search bar — expands below the header on small screens */}
      {mobileSearchOpen && (
        <div className="border-b border-white/5 bg-ink-900/90 px-4 py-2 sm:hidden">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const term = q.trim();
              if (term) {
                setMobileSearchOpen(false);
                navigate(`/?q=${encodeURIComponent(term)}`);
              }
            }}
          >
            <input
              className="input"
              placeholder="Search users and live broadcasts…"
              value={q}
              autoFocus
              onChange={(e) => setQ(e.target.value)}
            />
          </form>
        </div>
      )}

      {/* ─── Mobile drawer ────────────────────────────────────────────────── */}
      {drawerOpen && (
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
            {/* Drawer header: close button + user info (or brand when signed out) */}
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
              {user ? (
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
              ) : (
                <span className="font-bold">📡 PeerCast</span>
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

              {user ? (
                <>
                  <div className="space-y-1">
                    <DrawerLink
                      to="/dashboard"
                      onClose={() => setDrawerOpen(false)}
                    >
                      Dashboard
                    </DrawerLink>
                    <DrawerLink
                      to="/broadcast"
                      onClose={() => setDrawerOpen(false)}
                    >
                      Go live
                    </DrawerLink>
                    {user.role === "admin" && (
                      <DrawerLink
                        to="/admin"
                        onClose={() => setDrawerOpen(false)}
                      >
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
                </>
              ) : (
                /* Signed out: the header's Sign in / Register buttons are
                 * hidden below `sm` to keep the top bar from crowding, so they
                 * must reappear here or an anonymous visitor on a phone has no
                 * way to sign in at all. */
                <div className="space-y-2">
                  <DrawerLink
                    to="/login"
                    onClose={() => setDrawerOpen(false)}
                    className="justify-center font-semibold"
                  >
                    Sign in
                  </DrawerLink>
                  <DrawerLink
                    to="/register"
                    onClose={() => setDrawerOpen(false)}
                    className="justify-center bg-brand-600 font-semibold text-white hover:bg-brand-500"
                  >
                    Create account
                  </DrawerLink>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <main
        id="main-content"
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6"
      >
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

      {updatePrompt && (
        <Modal
          title="Update available"
          onClose={() => setUpdatePrompt(null)}
          actions={
            <>
              <button
                className="btn-ghost"
                onClick={() => setUpdatePrompt(null)}
              >
                Later
              </button>
              <button
                className="btn-primary"
                onClick={() => void applyUpdate()}
              >
                Update now
              </button>
            </>
          }
        >
          <p className="text-sm text-slate-300">
            PeerCast {updatePrompt.latest} is available (you have{" "}
            {updatePrompt.current}). The page will reload to apply it.
          </p>
        </Modal>
      )}
    </div>
  );
}
