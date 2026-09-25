import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Avatar } from "../components/Avatar";
import { BroadcastCard } from "../components/BroadcastCard";
import { IllustratedMessage } from "../components/IllustratedMessage";
import { Spinner } from "../components/Spinner";
import {
  useFollowUserMutation,
  useGetUserBroadcastsQuery,
  useGetUserFollowingQuery,
  useGetUserQuery,
  useUnfollowUserMutation,
} from "../store/api";
import { useAppSelector } from "../store";

function fmtDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
  });
}

export function UserProfilePage() {
  const { username = "" } = useParams();
  const authed = useAppSelector((s) => !!s.auth.accessToken);
  const myUsername = useAppSelector((s) => s.auth.user?.username);

  const { data: profile, isLoading, error } = useGetUserQuery(username);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const { data: history, isFetching: histFetching } = useGetUserBroadcastsQuery(
    { username, cursor },
    { skip: !username },
  );
  const [allBroadcasts, setAllBroadcasts] = useState<
    import("@peer-cast/shared").BroadcastWithUser[]
  >([]);

  // Accumulate broadcast pages as the user loads more.
  // Reset when cursor is undefined (initial load).
  const broadcasts =
    cursor === undefined
      ? (history?.broadcasts ?? [])
      : [...allBroadcasts, ...(history?.broadcasts ?? [])];

  function loadMore() {
    if (history?.nextCursor) {
      setAllBroadcasts(broadcasts);
      setCursor(history.nextCursor);
    }
  }

  const { data: followingData, isLoading: followingLoading } =
    useGetUserFollowingQuery(username, { skip: !authed });
  const following = followingData?.following ?? false;
  const isOwnProfile = authed && myUsername === profile?.user.username;

  const [followUser] = useFollowUserMutation();
  const [unfollowUser] = useUnfollowUserMutation();

  async function toggleFollow() {
    if (!authed) return;
    try {
      if (following) await unfollowUser(username).unwrap();
      else await followUser(username).unwrap();
    } catch {
      /* transient */
    }
  }

  if (isLoading) return <Spinner label="Loading profile…" />;
  if (error || !profile) {
    return (
      <IllustratedMessage
        icon="👤"
        title="User not found"
        description="This account doesn't exist or isn't publicly discoverable."
        action={
          <Link to="/" className="btn-primary">
            Back to home
          </Link>
        }
      />
    );
  }

  const { user, live } = profile;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* ── Profile card ──────────────────────────────────────────── */}
      <div className="card p-6">
        <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
          <Avatar user={user} size={88} />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold">{user.displayName}</h1>
            <p className="text-slate-400">@{username}</p>
            {user.about && (
              <p className="mt-2 text-sm text-slate-300">{user.about}</p>
            )}
            <p className="mt-2 text-xs text-slate-500">
              Member since {fmtDate(user.createdAt)}
            </p>
          </div>
          {authed && !isOwnProfile && (
            <button
              className={`btn shrink-0 ${following ? "btn-ghost" : "btn-primary"}`}
              onClick={() => void toggleFollow()}
              disabled={followingLoading}
              title={
                following
                  ? "Unfollow — you'll stop receiving live notifications"
                  : "Follow to be notified when this user goes live"
              }
            >
              {followingLoading ? "…" : following ? "✓ Following" : "+ Follow"}
            </button>
          )}
          {isOwnProfile && (
            <Link to="/settings" className="btn btn-ghost shrink-0">
              Edit profile
            </Link>
          )}
        </div>
      </div>

      {/* ── Live now ──────────────────────────────────────────────── */}
      {live && (
        <section>
          <h2 className="mb-3 text-xl font-bold">🔴 Live now</h2>
          <BroadcastCard broadcast={live} />
        </section>
      )}

      {/* ── Past broadcasts ───────────────────────────────────────── */}
      <section>
        <h2 className="mb-4 text-xl font-bold">Past broadcasts</h2>
        {broadcasts.length === 0 && !histFetching ? (
          <IllustratedMessage
            icon="📺"
            title="No public broadcasts yet"
            description={
              isOwnProfile
                ? "Your public broadcast history will appear here."
                : `${user.displayName} hasn't made any public broadcasts yet.`
            }
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {broadcasts.map((b) => (
                <BroadcastCard key={b.id} broadcast={b} />
              ))}
            </div>
            {histFetching && <Spinner label="Loading more…" />}
            {history?.nextCursor && !histFetching && (
              <div className="mt-6 flex justify-center">
                <button className="btn-ghost" onClick={loadMore}>
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
