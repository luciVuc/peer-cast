import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AdminUser, BroadcastWithUser, Report } from "@peer-cast/shared";
import { Avatar } from "../components/Avatar";
import { Modal } from "../components/Modal";
import { Spinner } from "../components/Spinner";
import { IllustratedMessage } from "../components/IllustratedMessage";
import {
  useAdminAuditLogQuery,
  useAdminInvitesQuery,
  useAdminMetricsQuery,
  useAdminReportsQuery,
  useAdminUsersQuery,
  useBanUserMutation,
  useCreateInviteMutation,
  useDisableInviteMutation,
  useListLiveQuery,
  useResolveReportMutation,
  useSetUserRoleMutation,
  useTakedownBroadcastMutation,
  useUnbanUserMutation,
} from "../store/api";

type Tab = "metrics" | "users" | "reports" | "live" | "invites" | "audit";

function fmt(ms: number) {
  return new Date(ms).toLocaleString();
}

// ─── Metrics tab ───────────────────────────────────────────────────────

type BarPoint = { date: string; value: number };

function BarSeries({ points, title }: { points: BarPoint[]; title: string }) {
  const max = Math.max(...points.map((p) => p.value), 1);
  return (
    <div className="card p-4">
      <h3 className="mb-4 font-semibold">{title}</h3>
      <div className="flex h-40 items-end gap-[2px]">
        {points.map((p) => {
          const pct = max > 0 ? Math.max((p.value / max) * 100, 2) : 2;
          return (
            <div
              key={p.date}
              className="flex flex-1 flex-col items-center justify-end"
              title={`${p.date}: ${p.value}`}
            >
              <span className="mb-1 text-[10px] leading-none text-slate-400">
                {p.value > 0 ? p.value : ""}
              </span>
              <div
                className="w-full rounded-sm bg-brand-500/70"
                style={{ height: `${pct}%` }}
                aria-label={`${p.date}: ${p.value}`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4">
      <div className="text-2xl font-bold">{value.toLocaleString()}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-slate-400">
        {label}
      </div>
    </div>
  );
}

function MetricsTab() {
  const { data, isFetching } = useAdminMetricsQuery(30, {
    pollingInterval: 30000,
  });
  if (isFetching && !data) return <Spinner label="Loading metrics…" />;
  const m = data?.metrics;
  const totals = m?.totals;
  const broadcastsPerDay: BarPoint[] = (m?.broadcastsPerDay ?? []).map(
    (d): BarPoint => ({ date: d.date, value: d.count }),
  );
  const usersPerDay: BarPoint[] = (m?.usersPerDay ?? []).map((d): BarPoint => ({
    date: d.date,
    value: d.count,
  }));
  const concurrentPeakPerDay: BarPoint[] = (m?.concurrentPeakPerDay ?? []).map(
    (d): BarPoint => ({ date: d.date, value: d.peak }),
  );

  return (
    <div className="space-y-6">
      {totals && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <MetricCard label="Users" value={totals.users} />
          <MetricCard label="Admins" value={totals.admins} />
          <MetricCard label="Viewers now" value={totals.currentViewers} />
          <MetricCard label="Live now" value={totals.liveBroadcasts} />
          <MetricCard label="Broadcasts" value={totals.broadcasts} />
          <MetricCard label="Total views" value={totals.totalViews} />
          <MetricCard
            label="Peak concurrent"
            value={totals.peakConcurrentViewers}
          />
          <MetricCard label="Peak today" value={totals.peakConcurrentToday} />
          <MetricCard label="Banned" value={totals.banned} />
          <MetricCard label="Unverified" value={totals.unverified} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <BarSeries
          title="Broadcasts per day (30 d)"
          points={broadcastsPerDay}
        />
        <BarSeries title="New users per day (30 d)" points={usersPerDay} />
        <BarSeries
          title="Peak viewers per day (30 d)"
          points={concurrentPeakPerDay}
        />
      </div>
      <p className="text-xs text-slate-500">
        Days are UTC. "Peak today" counts broadcasts that started today (UTC);
        "Peak viewers per day" is the highest peak_viewers of any broadcast that
        started on that day.
      </p>
    </div>
  );
}

// ─── Users tab ──────────────────────────────────────────────────────────

function UsersTab() {
  const [q, setQ] = useState("");
  const { data, isFetching } = useAdminUsersQuery(q);
  const [ban] = useBanUserMutation();
  const [unban, { isLoading: unbanning }] = useUnbanUserMutation();
  const [setRole, { isLoading: settingRole }] = useSetUserRoleMutation();

  // Ban modal state
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [banReason, setBanReason] = useState("");
  const [banning, setBanning] = useState(false);

  // Role-change confirmation modal state
  const [roleTarget, setRoleTarget] = useState<{
    user: AdminUser;
    role: "user" | "admin";
  } | null>(null);

  async function confirmBan() {
    if (!banTarget || banning) return;
    setBanning(true);
    try {
      await ban({
        username: banTarget.username,
        reason: banReason || undefined,
      });
      setBanTarget(null);
      setBanReason("");
    } finally {
      setBanning(false);
    }
  }

  async function confirmRoleChange() {
    if (!roleTarget || settingRole) return;
    await setRole({
      username: roleTarget.user.username,
      role: roleTarget.role,
    });
    setRoleTarget(null);
  }

  return (
    <div>
      <input
        className="input mb-4 max-w-sm"
        placeholder="Search users by name, @handle, or email…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {isFetching && !data ? (
        <Spinner label="Loading users…" />
      ) : (
        <div className="card divide-y divide-white/5">
          {(data?.users ?? []).map((u) => (
            <div
              key={u.username}
              className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap"
            >
              <Avatar user={u} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{u.displayName}</span>
                  {u.role === "admin" && (
                    <span className="badge bg-brand-600 text-white">admin</span>
                  )}
                  {u.banned && (
                    <span className="badge bg-red-600 text-white">banned</span>
                  )}
                  {u.live && (
                    <span className="badge bg-emerald-600 text-white">
                      live
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-slate-400">
                  @{u.username} · {u.email} · joined {fmt(u.createdAt)}
                  {u.banned && u.bannedReason
                    ? ` · reason: ${u.bannedReason}`
                    : ""}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {u.role !== "admin" &&
                  (u.banned ? (
                    <button
                      className="btn btn-ghost"
                      disabled={unbanning}
                      onClick={() => unban(u.username)}
                    >
                      {unbanning ? "…" : "Unban"}
                    </button>
                  ) : (
                    <button
                      className="btn-danger"
                      onClick={() => {
                        setBanReason("");
                        setBanTarget(u);
                      }}
                    >
                      Ban
                    </button>
                  ))}
                {u.role === "admin" ? (
                  <button
                    className="btn-ghost"
                    disabled={settingRole}
                    onClick={() => setRoleTarget({ user: u, role: "user" })}
                  >
                    Demote
                  </button>
                ) : (
                  <button
                    className="btn-ghost"
                    disabled={settingRole}
                    onClick={() => setRoleTarget({ user: u, role: "admin" })}
                  >
                    Make admin
                  </button>
                )}
              </div>
            </div>
          ))}
          {data?.users.length === 0 && (
            <div className="p-6 text-center text-sm text-slate-400">
              No users found.
            </div>
          )}
        </div>
      )}

      {/* Ban confirmation modal */}
      {banTarget && (
        <Modal
          title={`Ban @${banTarget.username}`}
          onClose={() => setBanTarget(null)}
          actions={
            <>
              <button
                className="btn-ghost"
                onClick={() => setBanTarget(null)}
                disabled={banning}
              >
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={confirmBan}
                disabled={banning}
              >
                {banning ? "Banning…" : "Ban user"}
              </button>
            </>
          }
        >
          <p className="mb-3 text-sm text-slate-400">
            This revokes their sessions, force-ends any live broadcast, and
            blocks login + signaling. You can unban later.
          </p>
          <label className="label">Reason (optional)</label>
          <textarea
            className="input"
            rows={3}
            autoFocus
            value={banReason}
            onChange={(e) => setBanReason(e.target.value)}
            placeholder="e.g. abusive content"
          />
        </Modal>
      )}

      {/* Role-change confirmation modal */}
      {roleTarget && (
        <Modal
          title={`Change role for @${roleTarget.user.username}`}
          onClose={() => setRoleTarget(null)}
          actions={
            <>
              <button
                className="btn-ghost"
                onClick={() => setRoleTarget(null)}
                disabled={settingRole}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={confirmRoleChange}
                disabled={settingRole}
              >
                {settingRole
                  ? "Saving…"
                  : roleTarget.role === "admin"
                    ? "Grant admin"
                    : "Revoke admin"}
              </button>
            </>
          }
        >
          <p className="text-sm text-slate-400">
            {roleTarget.role === "admin"
              ? `This will grant @${roleTarget.user.username} full admin privileges including ban, takedown, and role management.`
              : `This will revoke admin privileges from @${roleTarget.user.username}. The account remains active.`}
          </p>
        </Modal>
      )}
    </div>
  );
}

// ─── Reports tab ────────────────────────────────────────────────────────

function ReportRow({ r }: { r: Report }) {
  const [resolve, { isLoading: resolving }] = useResolveReportMutation();
  const [ban, { isLoading: banning }] = useBanUserMutation();
  return (
    <div className="flex flex-wrap items-start gap-3 p-3 sm:flex-nowrap">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/watch/${r.targetUsername}`}
            className="font-medium text-brand-400 hover:underline"
          >
            @{r.targetUsername}
          </Link>
          <span
            className={`badge ${
              r.status === "open"
                ? "bg-amber-600 text-white"
                : "bg-ink-700 text-slate-300"
            }`}
          >
            {r.status}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-200">{r.reason}</p>
        <div className="text-xs text-slate-400">
          {fmt(r.createdAt)}
          {r.reporterUsername ? ` · by @${r.reporterUsername}` : " · anonymous"}
          {r.resolvedBy ? ` · resolved by @${r.resolvedBy}` : ""}
        </div>
      </div>
      {r.status === "open" && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            className="btn-danger"
            disabled={banning}
            onClick={() =>
              ban({
                username: r.targetUsername,
                reason: `report: ${r.reason}`,
              })
            }
          >
            {banning ? "…" : "Ban user"}
          </button>
          <button
            className="btn-ghost"
            disabled={resolving}
            onClick={() => resolve({ id: r.id, status: "resolved" })}
          >
            {resolving ? "…" : "Resolve"}
          </button>
          <button
            className="btn-ghost"
            disabled={resolving}
            onClick={() => resolve({ id: r.id, status: "dismissed" })}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function ReportsTab() {
  const [status, setStatus] = useState("open");
  const { data, isFetching } = useAdminReportsQuery(status);
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {["open", "resolved", "dismissed", "all"].map((s) => (
          <button
            key={s}
            className={`btn capitalize ${status === s ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setStatus(s)}
          >
            {s}
          </button>
        ))}
      </div>
      {isFetching && !data ? (
        <Spinner label="Loading reports…" />
      ) : data && data.reports.length > 0 ? (
        <div className="card divide-y divide-white/5">
          {data.reports.map((r) => (
            <ReportRow key={r.id} r={r} />
          ))}
        </div>
      ) : (
        <IllustratedMessage icon="✅" title="No reports here" />
      )}
    </div>
  );
}

// ─── Live tab (takedown with confirmation) ──────────────────────────────

function LiveTab() {
  const { data, isLoading } = useListLiveQuery(undefined, {
    pollingInterval: 10000,
  });
  const [takedown, { isLoading: takingDown }] = useTakedownBroadcastMutation();
  const [takedownTarget, setTakedownTarget] =
    useState<BroadcastWithUser | null>(null);

  if (isLoading) return <Spinner label="Loading live broadcasts…" />;
  const broadcasts = data?.broadcasts ?? [];
  if (!broadcasts.length)
    return <IllustratedMessage icon="🌙" title="Nothing live right now" />;

  return (
    <>
      <div className="card divide-y divide-white/5">
        {broadcasts.map((b) => (
          <div
            key={b.id}
            className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap"
          >
            <Avatar user={b.owner} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{b.title}</div>
              <div className="truncate text-xs text-slate-400">
                @{b.owner.username} · {b.access} · {b.stats?.viewers ?? 0}{" "}
                watching
              </div>
            </div>
            <Link
              className="btn-ghost shrink-0"
              to={`/watch/${b.owner.username}`}
            >
              View
            </Link>
            <button
              className="btn-danger shrink-0"
              onClick={() => setTakedownTarget(b)}
            >
              Take down
            </button>
          </div>
        ))}
      </div>

      {takedownTarget && (
        <Modal
          title={`Take down broadcast?`}
          onClose={() => setTakedownTarget(null)}
          actions={
            <>
              <button
                className="btn-ghost"
                onClick={() => setTakedownTarget(null)}
                disabled={takingDown}
              >
                Cancel
              </button>
              <button
                className="btn-danger"
                disabled={takingDown}
                onClick={async () => {
                  await takedown(takedownTarget.id);
                  setTakedownTarget(null);
                }}
              >
                {takingDown ? "Taking down…" : "Confirm takedown"}
              </button>
            </>
          }
        >
          <p className="text-sm text-slate-400">
            Force-end{" "}
            <span className="font-semibold text-slate-200">
              "{takedownTarget.title}"
            </span>{" "}
            by @{takedownTarget.owner.username}? This immediately stops the
            broadcast and removes it from discovery.
          </p>
        </Modal>
      )}
    </>
  );
}

// ─── Invites tab ────────────────────────────────────────────────────────

function InvitesTab() {
  const { data, isFetching } = useAdminInvitesQuery();
  const [create, { isLoading }] = useCreateInviteMutation();
  const [disable] = useDisableInviteMutation();
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  async function onCreate() {
    await create({
      note: note.trim() || undefined,
      maxUses: maxUses ? Number(maxUses) : null,
      expiresInHours: expiresInHours ? Number(expiresInHours) : null,
    });
    setNote("");
    setMaxUses("");
    setExpiresInHours("");
  }

  function copy(code: string) {
    void navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  }

  const invites = data?.invites ?? [];
  return (
    <div className="space-y-6">
      <div className="card p-4">
        <h3 className="mb-3 font-semibold">Create an invite code</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <input
            className="input sm:col-span-2"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <input
            className="input"
            type="number"
            min={1}
            placeholder="Max uses (∞)"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />
          <input
            className="input"
            type="number"
            min={1}
            placeholder="Expires (hours)"
            value={expiresInHours}
            onChange={(e) => setExpiresInHours(e.target.value)}
          />
        </div>
        <button
          className="btn-primary mt-3"
          onClick={onCreate}
          disabled={isLoading}
        >
          {isLoading ? "Generating…" : "Generate code"}
        </button>
        <p className="mt-2 text-xs text-slate-500">
          Codes only take effect when the server's registration mode is{" "}
          <span className="text-slate-300">invite</span>.
        </p>
      </div>

      {isFetching && !data ? (
        <Spinner label="Loading invites…" />
      ) : invites.length === 0 ? (
        <IllustratedMessage icon="🎟️" title="No invite codes yet" />
      ) : (
        <div className="card divide-y divide-white/5">
          {invites.map((inv) => {
            const exhausted = inv.maxUses != null && inv.uses >= inv.maxUses;
            const expired = inv.expiresAt != null && inv.expiresAt < Date.now();
            const dead = inv.disabled || exhausted || expired;
            return (
              <div
                key={inv.code}
                className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap"
              >
                <code
                  className={`rounded bg-ink-900 px-2 py-1 font-mono text-sm ${
                    dead ? "text-slate-500 line-through" : "text-brand-300"
                  }`}
                >
                  {inv.code}
                </code>
                <div className="min-w-0 flex-1 text-xs text-slate-400">
                  {inv.note ? `${inv.note} · ` : ""}
                  uses {inv.uses}
                  {inv.maxUses != null ? `/${inv.maxUses}` : ""}
                  {inv.expiresAt
                    ? ` · expires ${fmt(inv.expiresAt)}`
                    : " · never expires"}
                  {inv.disabled ? " · disabled" : ""}
                  {expired ? " · expired" : ""}
                  {exhausted ? " · exhausted" : ""}
                </div>
                <button
                  className="btn-ghost shrink-0"
                  onClick={() => copy(inv.code)}
                >
                  {copied === inv.code ? "Copied ✓" : "Copy"}
                </button>
                {!inv.disabled && (
                  <button
                    className="btn-ghost shrink-0"
                    onClick={() => disable(inv.code)}
                  >
                    Disable
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Audit tab ──────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, string> = {
  ban: "🚫",
  unban: "✅",
  role_change: "👑",
  takedown: "📴",
  report_resolve: "📋",
  invite_create: "🎟️",
  invite_disable: "🔒",
  user_delete: "🗑️",
};

function AuditTab() {
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [allEntries, setAllEntries] = useState<
    {
      id: string;
      actorUsername: string;
      action: string;
      target: string;
      detail: string | null;
      createdAt: number;
    }[]
  >([]);
  const { data, isFetching } = useAdminAuditLogQuery(
    cursor ? { cursor } : undefined,
  );

  const entries =
    cursor === undefined
      ? (data?.entries ?? [])
      : [...allEntries, ...(data?.entries ?? [])];

  function loadMore() {
    if (data?.nextCursor) {
      setAllEntries(entries);
      setCursor(data.nextCursor);
    }
  }

  if (isFetching && !data) return <Spinner label="Loading audit log…" />;

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        Immutable record of all admin actions. Newest first.
      </p>
      {entries.length === 0 ? (
        <IllustratedMessage icon="📋" title="No admin actions recorded yet" />
      ) : (
        <div className="card divide-y divide-white/5">
          {entries.map((e) => (
            <div key={e.id} className="flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 text-lg" aria-hidden="true">
                {ACTION_ICONS[e.action] ?? "🔧"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold text-slate-200">
                    @{e.actorUsername}
                  </span>
                  <span className="badge bg-ink-700 text-slate-300 capitalize">
                    {e.action.replace("_", " ")}
                  </span>
                  <span className="text-brand-400">{e.target}</span>
                  {e.detail && (
                    <span className="truncate text-slate-400">
                      — {e.detail}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {fmt(e.createdAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {data?.nextCursor && !isFetching && (
        <div className="flex justify-center">
          <button className="btn-ghost" onClick={loadMore}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Page (UX-8: tab state in URL) ──────────────────────────────────────

export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "metrics";
  function setTab(t: Tab) {
    setParams({ tab: t }, { replace: true });
  }

  const { data: reports } = useAdminReportsQuery("open");
  const openCount = reports?.openCount ?? 0;

  const tabs: { key: Tab; label: string }[] = [
    { key: "metrics", label: "Metrics" },
    { key: "reports", label: `Reports${openCount ? ` (${openCount})` : ""}` },
    { key: "users", label: "Users" },
    { key: "live", label: "Live" },
    { key: "invites", label: "Invites" },
    { key: "audit", label: "Audit log" },
  ];

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Admin</h1>
      <div className="mb-6 flex flex-wrap gap-2 border-b border-white/5">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition ${
              tab === t.key
                ? "border-brand-500 text-brand-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "metrics" && <MetricsTab />}
      {tab === "users" && <UsersTab />}
      {tab === "reports" && <ReportsTab />}
      {tab === "live" && <LiveTab />}
      {tab === "invites" && <InvitesTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}
