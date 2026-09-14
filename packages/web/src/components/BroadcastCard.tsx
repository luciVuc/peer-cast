import { Link } from "react-router-dom";
import type { BroadcastWithUser } from "@peer-cast/shared";
import { Avatar } from "./Avatar";

const accessLabel: Record<string, string> = {
  public: "Public",
  authenticated: "Members",
  code: "Code",
};

export function BroadcastCard({ broadcast }: { broadcast: BroadcastWithUser }) {
  const viewers = broadcast.stats?.viewers ?? broadcast.peakViewers;
  const bitrate = broadcast.stats?.bitrateKbps;
  return (
    <Link
      to={`/watch/${broadcast.owner.username}`}
      className="card group flex flex-col overflow-hidden transition hover:border-brand-500/40"
    >
      <div className="relative flex aspect-video items-center justify-center bg-gradient-to-br from-ink-700 to-ink-900">
        <span className="text-4xl opacity-40 transition group-hover:scale-110">
          🖥️
        </span>
        {viewers > 0 && (
          <span className="badge absolute right-3 top-3 bg-black/60 text-slate-100">
            👁 {viewers}
            {bitrate ? ` · ${bitrate} kbps` : ""}
          </span>
        )}
        <span className="badge absolute left-3 top-3 bg-red-600 text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          LIVE
        </span>
      </div>
      <div className="flex items-start gap-3 p-4">
        <Avatar user={broadcast.owner} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-slate-100">
            {broadcast.title}
          </h3>
          <p className="truncate text-sm text-slate-400">
            {broadcast.owner.displayName} · @{broadcast.owner.username}
          </p>
        </div>
        <span className="badge bg-ink-700 text-slate-300">
          {accessLabel[broadcast.access] ?? broadcast.access}
        </span>
      </div>
    </Link>
  );
}
