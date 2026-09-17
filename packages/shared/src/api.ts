/**
 * PeerCast REST API request/response contracts.
 *
 * Base path: `/api`. All bodies are JSON. Authenticated endpoints expect
 * `Authorization: Bearer <accessToken>`.
 */

import type {
  AccessPolicy,
  AdminUser,
  Broadcast,
  BroadcastStats,
  BroadcastWithUser,
  CaptureSource,
  Invite,
  PublicUser,
  RegistrationMode,
  Report,
  SelfUser,
  UserRole,
} from "./models.js";

// ─── Envelope ───────────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  /** Optional machine-readable code, e.g. "USERNAME_TAKEN". */
  code?: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────

export interface RegisterRequest {
  username: string;
  email: string;
  displayName: string;
  password: string;
  about?: string | null;
  /** Required when the server's registration mode is "invite". */
  inviteCode?: string;
  /** Required only when bootstrapping a configured administrator handle. */
  adminBootstrapSecret?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  accessToken: string;
  /** Refresh token is delivered only as an HttpOnly cookie, not in this body. */
  user: SelfUser;
}

/** @deprecated No longer needed — refresh token travels as an HttpOnly cookie. */
export type RefreshRequest = Record<string, never>;

export interface RefreshResponse {
  accessToken: string;
}

// ─── Users / profile ─────────────────────────────────────────────────────

export interface UpdateProfileRequest {
  displayName?: string;
  about?: string | null;
  /** data:image/... URL; server stores and returns a hosted avatarUrl. */
  avatarDataUrl?: string | null;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface UserSettings {
  defaultAccess: AccessPolicy;
  defaultTitle: string;
  discoverable: boolean; // appear in public directory + live listing
}

export interface SelfProfileResponse {
  user: SelfUser;
  settings: UserSettings;
}

export interface SearchResponse {
  users: PublicUser[];
  broadcasts: BroadcastWithUser[];
}

/** Public profile plus the user's current live broadcast (if any). */
export interface UserProfileResponse {
  user: PublicUser;
  live: BroadcastWithUser | null;
}

// ─── Broadcasts ─────────────────────────────────────────────────────────────

export interface ListBroadcastsResponse {
  broadcasts: BroadcastWithUser[];
}

/** Start a broadcast (broadcaster host: web page or extension). */
export interface StartBroadcastRequest {
  title: string;
  description?: string | null;
  access: AccessPolicy;
  source: CaptureSource;
  peerId: string;
  /** Required when access === "code". */
  accessCode?: string;
}

export interface StartBroadcastResponse {
  broadcast: Broadcast;
}

export interface UpdateStatsRequest {
  stats: Omit<BroadcastStats, "updatedAt">;
}

/** Viewer resolves a broadcaster's live session by @username. */
export interface ResolveResponse {
  broadcast: BroadcastWithUser;
  /** Present when the caller is authorised to connect. */
  peerId: string | null;
  /** Short-lived access ticket for authenticated/code broadcasts. */
  ticket: string | null;
  /** True when the broadcast requires an access code the caller has not supplied. */
  needsCode?: boolean;
}

export interface VerifyTicketRequest {
  ticket: string;
  peerId: string;
}

export interface VerifyTicketResponse {
  ok: boolean;
  username: string | null;
}

// ─── Reports ────────────────────────────────────────────────────────────────

export interface CreateReportRequest {
  /** The @username being reported. */
  targetUsername: string;
  /** Optional specific broadcast id. */
  broadcastId?: string | null;
  reason: string;
}

// ─── Admin / moderation ───────────────────────────────────────────────────

export interface AdminUsersResponse {
  users: AdminUser[];
}

export interface AdminReportsResponse {
  reports: Report[];
}

export interface BanUserRequest {
  reason?: string;
}

export interface SetRoleRequest {
  role: UserRole;
}

export interface ResolveReportRequest {
  status: "resolved" | "dismissed";
}

// ─── Admin metrics ─────────────────────────────────────────────────────

/** One day in a metric series. date is YYYY-MM-DD (UTC). */
export interface MetricsDay {
  date: string;
  count: number;
}

export interface MetricsPeakDay {
  date: string;
  peak: number;
}

/** Aggregate admin stats + time-series for the dashboard Metrics tab. */
export interface AdminMetrics {
  totals: {
    users: number;
    admins: number;
    banned: number;
    /** Users who have not verified their email yet. */
    unverified: number;
    /** All-time ended broadcasts. */
    broadcasts: number;
    /** Currently live broadcasts. */
    liveBroadcasts: number;
    /** Sum of viewers across currently live broadcasts. */
    currentViewers: number;
    /** All-time viewer count (cumulative). */
    totalViews: number;
    /** Highest peak_viewers recorded for any single broadcast (all-time). */
    peakConcurrentViewers: number;
    /** Highest peak_viewers among broadcasts that started today (UTC). */
    peakConcurrentToday: number;
  };
  /** Broadcasts started per day, oldest first. */
  broadcastsPerDay: MetricsDay[];
  /** New users registered per day, oldest first. */
  usersPerDay: MetricsDay[];
  /** Highest peak_viewers among broadcasts started that day, oldest first. */
  concurrentPeakPerDay: MetricsPeakDay[];
}

export interface AdminMetricsResponse {
  metrics: AdminMetrics;
  days: number;
}

// ─── Email ────────────────────────────────────────────────────────────────────

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}

export interface ChangeEmailRequest {
  newEmail: string;
}

// ─── Following + push notifications ─────────────────────────────────────────

/** Whether the authed caller follows `@username` (`GET /api/users/:u/following`). */
export interface FollowingResponse {
  following: boolean;
}

/** A full Web Push subscription as handed to pushManager.subscribe(). */
export interface PushSubscriptionData {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushSubscribeRequest {
  subscription: PushSubscriptionData;
}

export interface PushUnsubscribeRequest {
  /** The endpoint currently registered; matches the persisted record. */
  endpoint: string;
}

/** Public VAPID key for pushManager.subscribe(); 404 when push is disabled. */
export interface PushVapidKeyResponse {
  publicKey: string;
}

// ─── Per-broadcast recording / replay ─────────────────────────────────────────

/** One stored replay (WebM on the server filesystem). */
export interface Recording {
  id: string;
  /** Title given at create time (defaults to the broadcast title). */
  title: string;
  /** The broadcast this recording captured, if the broadcaster attached one. */
  broadcastId: string | null;
  /** "recording" = chunks still uploading; "complete" = ready to replay. */
  status: "recording" | "complete";
  sizeBytes: number;
  durationMs: number;
  createdAt: number;
  completedAt: number | null;
}

export interface CreateRecordingRequest {
  title?: string;
  broadcastId?: string;
}

/** Binary chunk append (`PUT /api/recordings/:id/chunk`); body is raw bytes. */
export interface AppendChunkResponse {
  ok: boolean;
  sizeBytes: number;
}

export interface FinalizeRecordingRequest {
  /** Wall-clock duration of the recording, summed by the client. */
  durationMs?: number;
}

export interface RecordingListResponse {
  recordings: Recording[];
}

export interface RecordingResponse {
  recording: Recording;
}

// ─── Invites (admin) ────────────────────────────────────────────────

export interface CreateInviteRequest {
  note?: string;
  /** Max times the code can be used; omit/null for unlimited. */
  maxUses?: number | null;
  /** Hours until the code expires; omit for never. */
  expiresInHours?: number | null;
}

export interface AdminInvitesResponse {
  invites: Invite[];
}

// ─── Signaling config (delivered to clients so they hit the right broker) ────

export interface SignalConfig {
  host: string;
  port: number;
  path: string;
  secure: boolean;
  key?: string;
  /** Optional ICE servers (STUN/TURN) for restrictive NATs. */
  iceServers?: RTCIceServerConfig[];
}

export interface RTCIceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Public runtime config the web app fetches on boot (`GET /api/config`). */
export interface RuntimeConfig {
  signal: SignalConfig;
  appName: string;
  version: string;
  /** How new accounts may be created (drives the register UI). */
  registration: RegistrationMode;
  /** Whether the operator configured a secret-backed admin bootstrap path. */
  adminBootstrap: boolean;
}
