import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BroadcastCard } from "../components/BroadcastCard";
import { IllustratedMessage } from "../components/IllustratedMessage";
import { Spinner } from "../components/Spinner";
import { Avatar } from "../components/Avatar";
import { useListLiveQuery, useSearchQuery } from "../store/api";
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
      <section id="live">
        <h2 className="mb-4 text-2xl font-bold">Live now</h2>
        <LiveFeed />
      </section>
    </div>
  );
}
