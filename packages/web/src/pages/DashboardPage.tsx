import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import type { BroadcastWithUser, Recording } from "@peer-cast/shared";
import { Avatar } from "../components/Avatar";
import { Spinner } from "../components/Spinner";
import { IllustratedMessage } from "../components/IllustratedMessage";

const accessLabel: Record<string, string> = {
  public: "Public",
  authenticated: "Members",
  code: "Code",
};
import {
  useGetMeQuery,
  useMyBroadcastsQuery,
  useMyRecordingsQuery,
  useDeleteRecordingMutation,
  useSendVerificationMutation,
} from "../store/api";
import { useAppDispatch, useAppSelector } from "../store";
import { addToast } from "../store/toastSlice";

function fmtDate(ms: number) {
  return new Date(ms).toLocaleString();
}

function fmtDuration(start: number, end: number | null) {
  const ms = (end ?? Date.now()) - start;
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

function HistoryRow({ b }: { b: BroadcastWithUser }) {
  const live = b.status === "live";
  return (
    <div className="flex items-center gap-4 border-b border-white/5 px-4 py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{b.title}</span>
          {live && <span className="badge bg-red-600 text-white">LIVE</span>}
        </div>
        <div className="text-xs text-slate-500">
          {fmtDate(b.startedAt)} · {fmtDuration(b.startedAt, b.endedAt)} ·{" "}
          {accessLabel[b.access] ?? b.access} · peak {b.peakViewers} 👁
        </div>
      </div>
      {live ? (
        // Live: two actions — manage (broadcaster) and watch (viewer)
        <div className="flex shrink-0 gap-2">
          <Link to="/broadcast" className="btn-primary text-sm">
            Manage
          </Link>
          <Link to={`/watch/${b.owner.username}`} className="btn-ghost text-sm">
            Watch
          </Link>
        </div>
      ) : (
        <a
          href="#recordings"
          className="btn-ghost text-sm"
          title="Replays live in the Recordings section below"
        >
          Replay
        </a>
      )}
    </div>
  );
}

function fmtBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** Streams the replay with the JWT in a header (the <video> tag can't). */
function RecordingVideo({ id }: { id: string }) {
  const token = useAppSelector((s) => s.auth.accessToken);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/recordings/${id}/data`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, token]);
  if (failed)
    return <p className="text-sm text-red-400">Could not load replay.</p>;
  if (!src) return <Spinner label="Loading replay…" />;
  return (
    <video
      controls
      src={src}
      preload="metadata"
      className="w-full rounded-lg bg-black"
    />
  );
}

function RecordingRow({
  r,
  onDelete,
}: {
  r: Recording;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const complete = r.status === "complete";
  return (
    <div className="border-b border-white/5 px-4 py-3 last:border-0">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{r.title}</span>
            {!complete && (
              <span className="badge bg-amber-500/20 text-amber-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                saving…
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500">
            {fmtDate(r.createdAt)} · {fmtBytes(r.sizeBytes)}
            {r.durationMs > 0 ? ` · ${fmtDuration(0, r.durationMs)}` : ""}
          </div>
        </div>
        {complete && (
          <button
            className="btn-ghost text-sm"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide" : "Watch replay"}
          </button>
        )}
        <button
          className="btn-ghost text-sm text-red-400 hover:text-red-300"
          onClick={() => onDelete(r.id)}
          title="Delete recording (file + metadata)"
        >
          Delete
        </button>
      </div>
      {open && complete && (
        <div className="mt-3">
          <RecordingVideo id={r.id} />
        </div>
      )}
    </div>
  );
}

function RecordingsSection() {
  const { data, isLoading } = useMyRecordingsQuery();
  const [deleteRecording] = useDeleteRecordingMutation();
  const dispatch = useAppDispatch();
  const recordings = data?.recordings ?? [];

  async function remove(id: string) {
    try {
      await deleteRecording(id).unwrap();
      dispatch(addToast("Recording deleted.", "success"));
    } catch {
      dispatch(addToast("Could not delete recording.", "error"));
    }
  }

  return (
    <section id="recordings" className="scroll-mt-20">
      <h2 className="mb-4 text-2xl font-bold">Recordings</h2>
      <div className="card overflow-hidden">
        {isLoading ? (
          <Spinner label="Loading recordings…" />
        ) : recordings.length === 0 ? (
          <IllustratedMessage
            icon="📼"
            title="No recordings yet"
            description="Hit the Record button on the broadcast page to capture a private replay of any broadcast."
          />
        ) : (
          recordings.map((r) => (
            <RecordingRow key={r.id} r={r} onDelete={remove} />
          ))
        )}
      </div>
    </section>
  );
}

export function DashboardPage() {
  const { data: me, isLoading: meLoading } = useGetMeQuery();
  const { data, isLoading } = useMyBroadcastsQuery();
  const [sendVerification] = useSendVerificationMutation();
  const dispatch = useAppDispatch();
  const broadcastStatus = useAppSelector((s) => s.broadcast.status);
  const activeBroadcast = useAppSelector((s) => s.broadcast.active);

  if (meLoading || !me) return <Spinner label="Loading dashboard…" />;

  const broadcasts = data?.broadcasts ?? [];
  const liveCount = broadcasts.filter((b) => b.status === "live").length;
  const totalPeak = broadcasts.reduce((a, b) => a + b.peakViewers, 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      {/* ─── Live broadcast banner ───────────────────────────────── */}
      {broadcastStatus === "live" && activeBroadcast && (
        <div className="col-span-full flex items-center justify-between gap-4 rounded-xl border border-red-500/40 bg-red-900/30 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-semibold text-white">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
              LIVE
            </span>
            <span className="font-medium text-slate-100">
              {activeBroadcast.title}
            </span>
          </div>
          <Link to="/broadcast" className="btn-primary shrink-0">
            Return to broadcast
          </Link>
        </div>
      )}

      {/* ─── Email verification banner ──────────────────────────── */}
      {me && !me.user.emailVerified && (
        <div className="col-span-full flex items-center justify-between gap-4 rounded-xl border border-amber-500/40 bg-amber-900/30 px-4 py-3 text-sm">
          <span className="text-amber-200">
            ⚠️ Please verify your email address to secure your account.
          </span>
          <button
            className="btn-ghost shrink-0"
            onClick={async () => {
              try {
                await sendVerification().unwrap();
                dispatch(addToast("Verification email sent!", "success"));
              } catch {
                dispatch(
                  addToast("Could not send email. Try again later.", "error"),
                );
              }
            }}
          >
            Resend email
          </button>
        </div>
      )}
      {/* Profile summary */}
      <aside className="space-y-4">
        <div className="card p-5 text-center">
          <div className="flex justify-center">
            <Avatar user={me.user} size={80} />
          </div>
          <h2 className="mt-3 text-lg font-bold">{me.user.displayName}</h2>
          <p className="text-sm text-slate-400">@{me.user.username}</p>
          {me.user.about && (
            <p className="mt-2 text-sm text-slate-300">{me.user.about}</p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            {broadcastStatus === "live" ? (
              <Link to="/broadcast" className="btn-danger">
                <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-white" />
                Return to broadcast
              </Link>
            ) : (
              <Link to="/broadcast" className="btn-primary">
                Go live
              </Link>
            )}
            <Link to="/settings" className="btn-ghost">
              Edit profile &amp; settings
            </Link>
          </div>
        </div>

        <div className="card grid grid-cols-3 gap-2 p-4 text-center">
          <div>
            <div className="text-2xl font-bold">{broadcasts.length}</div>
            <div className="text-xs text-slate-500">Broadcasts</div>
          </div>
          <div>
            <div className="text-2xl font-bold">{liveCount}</div>
            <div className="text-xs text-slate-500">Live now</div>
          </div>
          <div>
            <div className="text-2xl font-bold">{totalPeak}</div>
            <div className="text-xs text-slate-500">Total peak 👁</div>
          </div>
        </div>
      </aside>

      {/* Broadcast history */}
      <section>
        <h1 className="mb-4 text-2xl font-bold">Broadcast history</h1>
        <div className="card overflow-hidden">
          {isLoading ? (
            <Spinner label="Loading broadcasts…" />
          ) : broadcasts.length === 0 ? (
            <IllustratedMessage
              icon="🎬"
              title="No broadcasts yet"
              description="Start your first broadcast to see it here."
              action={
                <Link to="/broadcast" className="btn-primary">
                  Go live
                </Link>
              }
            />
          ) : (
            broadcasts.map((b) => <HistoryRow key={b.id} b={b} />)
          )}
        </div>
      </section>

      {/* Recordings (per-broadcast replay) */}
      <RecordingsSection />
    </div>
  );
}
