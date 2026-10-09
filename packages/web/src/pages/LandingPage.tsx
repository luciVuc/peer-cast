import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BroadcastCard } from "../components/BroadcastCard";
import { IllustratedMessage } from "../components/IllustratedMessage";
import { Spinner } from "../components/Spinner";
import { Avatar } from "../components/Avatar";
import {
  useGetConfigQuery,
  useListLiveQuery,
  useSearchQuery,
} from "../store/api";
import { useAppSelector } from "../store";

function Hero() {
  const user = useAppSelector((s) => s.auth.user);
  return (
    <section className="card mb-8 overflow-hidden">
      <div className="grid gap-6 p-8 sm:grid-cols-2 sm:items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Broadcast your screen,{" "}
            <span className="text-brand-400">peer-to-peer.</span>
          </h1>
          <p className="mt-3 text-slate-400">
            PeerCast streams your screen or tab directly to viewers over WebRTC.
            Media never touches a server — only a tiny signaling handshake does.
            Find a creator by @username and watch instantly.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {user ? (
              <Link to="/broadcast" className="btn-primary w-full sm:w-auto">
                Start broadcasting
              </Link>
            ) : (
              <Link to="/register" className="btn-primary w-full sm:w-auto">
                Create free account
              </Link>
            )}
            <a href="#live" className="btn-ghost w-full sm:w-auto">
              Browse live
            </a>
          </div>
        </div>
        <ul className="space-y-3 text-sm text-slate-300">
          <li className="flex gap-2">✅ True end-to-end P2P via WebRTC</li>
          <li className="flex gap-2">
            ✅ Public, members-only, or code-gated broadcasts
          </li>
          <li className="flex gap-2">
            ✅ Broadcast from the browser — extension optional
          </li>
          <li className="flex gap-2">
            ✅ Installable PWA, self-hostable backend
          </li>
        </ul>
      </div>
    </section>
  );
}

function SearchResults({ q }: { q: string }) {
  const { data, isFetching } = useSearchQuery(q);
  if (isFetching) return <Spinner label="Searching…" />;
  const users = data?.users ?? [];
  const broadcasts = data?.broadcasts ?? [];
  if (!users.length && !broadcasts.length) {
    return (
      <IllustratedMessage
        icon="🔍"
        title={`No results for "${q}"`}
        description="Try another name or @username."
      />
    );
  }
  return (
    <div className="space-y-8">
      {broadcasts.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Live now</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {broadcasts.map((b) => (
              <BroadcastCard key={b.id} broadcast={b} />
            ))}
          </div>
        </section>
      )}
      {users.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">People</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {users.map((u) => (
              <Link
                key={u.username}
                to={`/watch/${u.username}`}
                className="card flex items-center gap-3 p-3 hover:border-brand-500/40"
              >
                <Avatar user={u} size={44} />
                <div className="min-w-0">
                  <div className="truncate font-medium">{u.displayName}</div>
                  <div className="truncate text-sm text-slate-400">
                    @{u.username}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function LiveFeed() {
  const { data, isLoading, error } = useListLiveQuery(undefined, {
    pollingInterval: 15000,
  });
  if (isLoading) return <Spinner label="Loading live broadcasts…" />;
  if (error)
    return (
      <IllustratedMessage
        icon="⚠️"
        title="Couldn't reach the server"
        description="The API may be offline. Try again shortly."
      />
    );
  const broadcasts = data?.broadcasts ?? [];
  if (!broadcasts.length) {
    return (
      <IllustratedMessage
        icon="🌙"
        title="Nobody is live right now"
        description="Check back soon — or start your own broadcast."
      />
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {broadcasts.map((b) => (
        <BroadcastCard key={b.id} broadcast={b} />
      ))}
    </div>
  );
}

/**
 * First-run card for someone who just started their own instance.
 *
 * A self-hoster lands on an empty feed and gets "Nobody is live right now" —
 * which reads as broken rather than new. This names the two things that make
 * the instance usable (an admin handle, an invite path) and states the mode the
 * server is actually in, so the first thing they do is the right thing.
 *
 * Dismissed state lives in localStorage, so it appears once and stays gone;
 * signed-in users never see it.
 */
const ONBOARDING_KEY = "peercast.onboarding.dismissed";

function FirstRunCard() {
  const user = useAppSelector((s) => s.auth.user);
  const { data: cfg } = useGetConfigQuery();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ONBOARDING_KEY) === "1";
    } catch {
      // Private mode / blocked storage: show it every visit rather than never.
      return false;
    }
  });

  if (user || dismissed || !cfg) return null;

  const mode = cfg.registration;
  const modeCopy =
    mode === "closed"
      ? "Registration is closed — only the configured admin can create accounts."
      : mode === "invite"
        ? "Registration is invite-only. Generate a code from the admin console to let someone in."
        : "Registration is open — anyone can create an account on this instance.";

  return (
    <section
      id="first-run"
      aria-labelledby="first-run-title"
      className="card mb-8 border-brand-500/30 bg-brand-500/5 p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="first-run-title" className="text-lg font-bold tracking-tight">
            New here? You're looking at your own instance.
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            PeerCast {cfg.version} · {modeCopy}
          </p>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-300">
            <li>
              Create the admin account you configured with{" "}
              <code className="rounded bg-ink-700 px-1 py-0.5 text-xs">
                ADMIN_USERNAMES
              </code>
              , supplying{" "}
              <code className="rounded bg-ink-700 px-1 py-0.5 text-xs">
                ADMIN_BOOTSTRAP_SECRET
              </code>{" "}
              the first time. That handle is what unlocks{" "}
              <a className="underline" href="/admin">
                /admin
              </a>
              .
            </li>
            <li>
              Go live from the browser — screen, tab, or camera. Screen capture
              needs <strong>HTTPS</strong>; the optional extension is only for
              tab audio.
            </li>
            <li>
              Install it as an app from your browser's menu for a standalone
              window and push notifications.
            </li>
          </ol>
          <p className="mt-4 text-xs text-slate-500">
            Full setup, TLS, TURN, and reverse-proxy notes are in the README.
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-ink-700 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500/60"
          onClick={() => {
            try {
              localStorage.setItem(ONBOARDING_KEY, "1");
            } catch {
              /* ignore — worst case it shows again next visit */
            }
            setDismissed(true);
          }}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}

export function LandingPage() {
  const [params] = useSearchParams();
  const q = useMemo(() => (params.get("q") ?? "").trim(), [params]);

  if (q) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold">
          Results for <span className="text-brand-400">“{q}”</span>
        </h1>
        <SearchResults q={q} />
      </div>
    );
  }

  return (
    <div>
      <Hero />
      <FirstRunCard />
      <section id="live">
        <h2 className="mb-4 text-2xl font-bold">Live now</h2>
        <LiveFeed />
      </section>
    </div>
  );
}
