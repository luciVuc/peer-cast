/**
 * PeerCast shared domain model.
 *
 * These types are the single source of truth for entities that cross the
 * server / web / extension boundary. Server persists them in SQLite; the web
 * app and extension consume them over the REST API.
 */

/** Who is allowed to watch a broadcast. */
export type AccessPolicy = "public" | "authenticated" | "code";

/** Account privilege level. */
export type UserRole = "user" | "admin";

/** How new accounts may be created. */
export type RegistrationMode = "open" | "invite" | "closed";

/** Lifecycle of a broadcast record. */
export type BroadcastStatus = "live" | "ended";

/** How the broadcast media is being captured. */
export type CaptureSource = "tab" | "screen" | "window" | "camera";

/** Public-safe view of a registered user (never includes secrets). */
export interface PublicUser {
  username: string; // canonical display-case handle
  displayName: string;
  about: string | null;
  avatarUrl: string | null;
  createdAt: number;
}

/** The authenticated user's own account view (adds private fields). */
export interface SelfUser extends PublicUser {
  email: string;
  role: UserRole;
  emailVerified: boolean;
  updatedAt: number;
}

/** Admin-only view of an account (adds moderation fields). */
export interface AdminUser extends PublicUser {
  email: string;
  role: UserRole;
  discoverable: boolean;
  banned: boolean;
  bannedReason: string | null;
  bannedAt: number | null;
  live: boolean;
}

/** An invite code that authorises registration when mode is "invite". */
export interface Invite {
  code: string;
  note: string | null;
  maxUses: number | null; // null = unlimited
  uses: number;
  expiresAt: number | null; // null = never
  createdBy: string | null;
  createdAt: number;
  disabled: boolean;
}

/** Report lifecycle. */
export type ReportStatus = "open" | "resolved" | "dismissed";

/** An abuse report filed against a user/broadcast. */
export interface Report {
  id: string;
  targetUsername: string;
  broadcastId: string | null;
  reporterUsername: string | null;
  reason: string;
  status: ReportStatus;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

/** A broadcast session (live now, or a historical record once ended). */
export interface Broadcast {
  id: string;
  username: string; // owner handle (display case)
  title: string;
  description: string | null;
  status: BroadcastStatus;
  access: AccessPolicy;
  source: CaptureSource;
  /** PeerJS peer id of the current host — only present while live and resolvable. */
  peerId: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Peak concurrent viewers observed during the session. */
  peakViewers: number;
  /** Total distinct viewer connections over the session. */
  totalViews: number;
}

/** Point-in-time stats pushed by the broadcaster host. */
export interface BroadcastStats {
  viewers: number;
  bitrateKbps: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  updatedAt: number;
  /** Cumulative count of all accepted viewer connections this session. */
  totalConnections?: number;
}

/** A broadcast enriched with the owner's public profile (for cards/lists). */
export interface BroadcastWithUser extends Broadcast {
  owner: PublicUser;
  stats?: BroadcastStats;
}
