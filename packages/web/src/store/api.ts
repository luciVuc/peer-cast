import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
} from "@reduxjs/toolkit/query/react";
import type {
  AdminInvitesResponse,
  AdminMetricsResponse,
  AdminReportsResponse,
  AdminUser,
  AppendChunkResponse,
  AuthResponse,
  Broadcast,
  BroadcastWithUser,
  ChangeEmailRequest,
  ChangePasswordRequest,
  CreateInviteRequest,
  CreateRecordingRequest,
  CreateReportRequest,
  FollowingResponse,
  ForgotPasswordRequest,
  Invite,
  ListBroadcastsResponse,
  LoginRequest,
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  PushVapidKeyResponse,
  RecordingListResponse,
  RecordingResponse,
  RegisterRequest,
  Report,
  ResetPasswordRequest,
  ResolveResponse,
  RuntimeConfig,
  SearchResponse,
  SelfProfileResponse,
  StartBroadcastRequest,
  StartBroadcastResponse,
  UpdateProfileRequest,
  UserProfileResponse,
  UserRole,
  UserSettings,
  VerifyTicketResponse,
} from "@peer-cast/shared";
import { tokensUpdated, loggedOut } from "./authSlice";
import type { RootState } from "./index";

const rawBaseQuery = fetchBaseQuery({
  baseUrl: "/api",
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as RootState).auth.accessToken;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  },
});

/** Base query that transparently refreshes the access token on a 401.
 *
 * The refresh is single-flight: refresh tokens rotate on every use and the
 * server now revokes an entire token family when a consumed token is
 * replayed. Two concurrent 401-drivers both calling /auth/refresh would have
 * one of them replay the just-rotated cookie, killing the session for the
 * legit client too. Sharing one in-flight promise avoids that race.
 */
let refreshInFlight: Promise<ReturnType<typeof rawBaseQuery>> | null = null;

const baseQueryWithReauth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError
> = async (args, apiCtx, extraOptions) => {
  let result = await rawBaseQuery(args, apiCtx, extraOptions);
  if (result.error?.status === 401) {
    const { user } = (apiCtx.getState() as RootState).auth;
    // Only attempt a refresh if we think we're logged in (have a cached user).
    if (user) {
      // No request body — the HttpOnly refresh-token cookie is sent automatically.
      if (!refreshInFlight) {
        refreshInFlight = (async () => {
          try {
            return await rawBaseQuery(
              { url: "/auth/refresh", method: "POST" },
              apiCtx,
              extraOptions,
            );
          } finally {
            refreshInFlight = null;
          }
        })();
      }
      const refresh = await refreshInFlight;
      if (refresh.data) {
        const data = refresh.data as { accessToken: string };
        apiCtx.dispatch(tokensUpdated({ accessToken: data.accessToken }));
        result = await rawBaseQuery(args, apiCtx, extraOptions);
      } else {
        apiCtx.dispatch(loggedOut());
        // The session is gone; drop every cached result (the old user's
        // profile, broadcasts, etc.) so a later login can't surface stale data.
        apiCtx.dispatch(api.util.resetApiState());
      }
    }
  }
  return result;
};

export const api = createApi({
  reducerPath: "api",
  baseQuery: baseQueryWithReauth,
  tagTypes: [
    "Me",
    "MyBroadcasts",
    "Live",
    "User",
    "Session",
    "Follow",
    "Push",
    "Recordings",
    "AdminUsers",
    "AdminReports",
    "AdminInvites",
  ],
  endpoints: (b) => ({
    // ─── runtime config ──────────────────────────────────────────────
    getConfig: b.query<RuntimeConfig, void>({ query: () => "/config" }),

    // ─── auth ────────────────────────────────────────────────────────
    // `Me` is invalidated on login/register so a cached profile from a
    // previous account can never linger after a session switch.
    register: b.mutation<AuthResponse, RegisterRequest>({
      query: (body) => ({ url: "/auth/register", method: "POST", body }),
      invalidatesTags: ["Me"],
    }),
    login: b.mutation<AuthResponse, LoginRequest>({
      query: (body) => ({ url: "/auth/login", method: "POST", body }),
      invalidatesTags: ["Me"],
    }),

    // ─── profile / settings ──────────────────────────────────────────
    getMe: b.query<SelfProfileResponse, void>({
      query: () => "/users/me",
      providesTags: ["Me"],
    }),
    updateProfile: b.mutation<
      { user: SelfProfileResponse["user"] },
      UpdateProfileRequest
    >({
      query: (body) => ({ url: "/users/me", method: "PUT", body }),
      invalidatesTags: ["Me"],
    }),
    updateSettings: b.mutation<
      { settings: UserSettings },
      Partial<UserSettings>
    >({
      query: (body) => ({ url: "/users/me/settings", method: "PUT", body }),
      invalidatesTags: ["Me"],
    }),
    changePassword: b.mutation<{ ok: boolean }, ChangePasswordRequest>({
      query: (body) => ({ url: "/users/me/password", method: "PUT", body }),
    }),

    // ─── directory / discovery ───────────────────────────────────────
    search: b.query<SearchResponse, string>({
      query: (q) => `/users/search?q=${encodeURIComponent(q)}`,
    }),
    getUser: b.query<UserProfileResponse, string>({
      query: (username) => `/users/${encodeURIComponent(username)}`,
      providesTags: (_r, _e, username) => [{ type: "User", id: username }],
    }),
    listLive: b.query<ListBroadcastsResponse, void>({
      query: () => "/broadcasts/live",
      providesTags: ["Live"],
    }),

    // ─── my broadcasts ───────────────────────────────────────────────
    myBroadcasts: b.query<ListBroadcastsResponse, void>({
      query: () => "/broadcasts/mine",
      providesTags: ["MyBroadcasts"],
    }),
    startBroadcast: b.mutation<StartBroadcastResponse, StartBroadcastRequest>({
      query: (body) => ({ url: "/broadcasts", method: "POST", body }),
      invalidatesTags: ["MyBroadcasts", "Live"],
    }),
    endBroadcast: b.mutation<{ broadcast: Broadcast }, string>({
      query: (id) => ({ url: `/broadcasts/${id}/end`, method: "POST" }),
      invalidatesTags: ["MyBroadcasts", "Live"],
    }),
    updateStats: b.mutation<
      { broadcast: BroadcastWithUser },
      { id: string; stats: import("@peer-cast/shared").BroadcastStats }
    >({
      query: ({ id, stats }) => ({
        url: `/broadcasts/${id}/stats`,
        method: "POST",
        body: { stats },
      }),
    }),

    // ─── viewer session resolve ──────────────────────────────────────
    resolveSession: b.query<
      ResolveResponse,
      { username: string; code?: string }
    >({
      query: ({ username, code }) =>
        `/sessions/${encodeURIComponent(username)}${code ? `?code=${encodeURIComponent(code)}` : ""}`,
      providesTags: (_r, _e, { username }) => [
        { type: "Session", id: username },
      ],
    }),
    verifyTicket: b.mutation<
      VerifyTicketResponse,
      { ticket: string; peerId: string }
    >({
      query: (body) => ({
        url: "/sessions/verify-ticket",
        method: "POST",
        body,
      }),
    }),

    // ─── reports ────────────────────────────────────────────────────────
    createReport: b.mutation<
      { ok: boolean; report: Report },
      CreateReportRequest
    >({
      query: (body) => ({ url: "/reports", method: "POST", body }),
      invalidatesTags: ["AdminReports"],
    }),

    // ─── admin / moderation ─────────────────────────────────────────────
    adminUsers: b.query<{ users: AdminUser[] }, string>({
      query: (q) => `/admin/users?q=${encodeURIComponent(q)}`,
      providesTags: ["AdminUsers"],
    }),
    adminReports: b.query<AdminReportsResponse & { openCount: number }, string>(
      {
        query: (status) =>
          `/admin/reports?status=${encodeURIComponent(status)}`,
        providesTags: ["AdminReports"],
      },
    ),
    banUser: b.mutation<
      { ok: boolean; user: AdminUser },
      { username: string; reason?: string }
    >({
      query: ({ username, reason }) => ({
        url: `/admin/users/${encodeURIComponent(username)}/ban`,
        method: "POST",
        body: { reason },
      }),
      invalidatesTags: ["AdminUsers", "Live"],
    }),
    unbanUser: b.mutation<{ ok: boolean; user: AdminUser }, string>({
      query: (username) => ({
        url: `/admin/users/${encodeURIComponent(username)}/unban`,
        method: "POST",
      }),
      invalidatesTags: ["AdminUsers"],
    }),
    setUserRole: b.mutation<
      { ok: boolean; user: AdminUser },
      { username: string; role: UserRole }
    >({
      query: ({ username, role }) => ({
        url: `/admin/users/${encodeURIComponent(username)}/role`,
        method: "PUT",
        body: { role },
      }),
      invalidatesTags: ["AdminUsers"],
    }),
    takedownBroadcast: b.mutation<
      { ok: boolean; broadcast: Broadcast },
      string
    >({
      query: (id) => ({
        url: `/admin/broadcasts/${id}/takedown`,
        method: "POST",
      }),
      invalidatesTags: ["AdminUsers", "Live"],
    }),
    resolveReport: b.mutation<
      { ok: boolean; report: Report },
      { id: string; status: "resolved" | "dismissed" }
    >({
      query: ({ id, status }) => ({
        url: `/admin/reports/${id}/resolve`,
        method: "POST",
        body: { status },
      }),
      invalidatesTags: ["AdminReports"],
    }),
    adminInvites: b.query<AdminInvitesResponse, void>({
      query: () => "/admin/invites",
      providesTags: ["AdminInvites"],
    }),
    createInvite: b.mutation<
      { ok: boolean; invite: Invite },
      CreateInviteRequest
    >({
      query: (body) => ({ url: "/admin/invites", method: "POST", body }),
      invalidatesTags: ["AdminInvites"],
    }),
    disableInvite: b.mutation<{ ok: boolean; invite: Invite }, string>({
      query: (code) => ({
        url: `/admin/invites/${encodeURIComponent(code)}/disable`,
        method: "POST",
      }),
      invalidatesTags: ["AdminInvites"],
    }),
    adminMetrics: b.query<AdminMetricsResponse, number | void>({
      query: (days) => `/admin/metrics${days ? `?days=${days}` : ""}`,
    }),

    deleteAccount: b.mutation<{ ok: boolean }, { password: string }>({
      query: (body) => ({ url: "/users/me", method: "DELETE", body }),
    }),

    // ─── signaling ticket ─────────────────────────────────────────────────────
    signalingTicket: b.mutation<{ token: string }, void>({
      query: () => ({ url: "/auth/signaling-ticket", method: "POST" }),
    }),

    // ─── email verification + password reset + email change ───────────────
    sendVerification: b.mutation<{ ok: boolean }, void>({
      query: () => ({ url: "/auth/send-verification", method: "POST" }),
      invalidatesTags: ["Me"],
    }),
    forgotPassword: b.mutation<{ ok: boolean }, ForgotPasswordRequest>({
      query: (body) => ({ url: "/auth/forgot-password", method: "POST", body }),
    }),
    resetPassword: b.mutation<{ ok: boolean }, ResetPasswordRequest>({
      query: (body) => ({ url: "/auth/reset-password", method: "POST", body }),
    }),
    changeEmail: b.mutation<{ ok: boolean }, ChangeEmailRequest>({
      query: (body) => ({ url: "/auth/change-email", method: "POST", body }),
      invalidatesTags: ["Me"],
    }),

    // ─── following ───────────────────────────────────────────────────────
    getUserFollowing: b.query<FollowingResponse, string>({
      query: (username) => `/users/${encodeURIComponent(username)}/following`,
      providesTags: (_r, _e, username) => [{ type: "Follow", id: username }],
    }),
    followUser: b.mutation<{ ok: boolean; following: boolean }, string>({
      query: (username) => ({
        url: `/users/${encodeURIComponent(username)}/follow`,
        method: "POST",
      }),
      invalidatesTags: (_r, _e, username) => [{ type: "Follow", id: username }],
    }),
    unfollowUser: b.mutation<{ ok: boolean; following: boolean }, string>({
      query: (username) => ({
        url: `/users/${encodeURIComponent(username)}/follow`,
        method: "DELETE",
      }),
      invalidatesTags: (_r, _e, username) => [{ type: "Follow", id: username }],
    }),

    // ─── push notifications ─────────────────────────────────────────────
    getVapidKey: b.query<PushVapidKeyResponse, void>({
      query: () => "/push/vapid-key",
      providesTags: ["Push"],
    }),
    subscribePush: b.mutation<{ ok: boolean }, PushSubscribeRequest>({
      query: (body) => ({ url: "/push/subscribe", method: "POST", body }),
      invalidatesTags: ["Push"],
    }),
    unsubscribePush: b.mutation<{ ok: boolean }, PushUnsubscribeRequest>({
      query: (body) => ({
        url: "/push/subscribe",
        method: "DELETE",
        body,
      }),
      invalidatesTags: ["Push"],
    }),

    // ─── per-broadcast recording / replay ───────────────────────────────
    myRecordings: b.query<RecordingListResponse, void>({
      query: () => "/recordings",
      providesTags: ["Recordings"],
    }),
    createRecording: b.mutation<RecordingResponse, CreateRecordingRequest>({
      query: (body) => ({ url: "/recordings", method: "POST", body }),
      invalidatesTags: ["Recordings"],
    }),
    uploadRecordingChunk: b.mutation<
      AppendChunkResponse,
      { id: string; body: Blob }
    >({
      query: ({ id, body }) => ({
        url: `/recordings/${id}/chunk`,
        method: "PUT",
        body,
      }),
    }),
    finalizeRecording: b.mutation<
      RecordingResponse,
      { id: string; durationMs?: number }
    >({
      query: ({ id, durationMs }) => ({
        url: `/recordings/${id}/finalize`,
        method: "POST",
        body: { durationMs },
      }),
      invalidatesTags: ["Recordings"],
    }),
    deleteRecording: b.mutation<{ ok: boolean }, string>({
      query: (id) => ({ url: `/recordings/${id}`, method: "DELETE" }),
      invalidatesTags: ["Recordings"],
    }),
  }),
});

export const {
  useGetConfigQuery,
  useRegisterMutation,
  useLoginMutation,
  useGetMeQuery,
  useUpdateProfileMutation,
  useUpdateSettingsMutation,
  useChangePasswordMutation,
  useSearchQuery,
  useLazySearchQuery,
  useGetUserQuery,
  useListLiveQuery,
  useMyBroadcastsQuery,
  useStartBroadcastMutation,
  useEndBroadcastMutation,
  useUpdateStatsMutation,
  useResolveSessionQuery,
  useLazyResolveSessionQuery,
  useVerifyTicketMutation,
  useCreateReportMutation,
  useAdminUsersQuery,
  useAdminReportsQuery,
  useBanUserMutation,
  useUnbanUserMutation,
  useSetUserRoleMutation,
  useTakedownBroadcastMutation,
  useResolveReportMutation,
  useAdminInvitesQuery,
  useAdminMetricsQuery,
  useCreateInviteMutation,
  useDisableInviteMutation,
  useSendVerificationMutation,
  useSignalingTicketMutation,
  useDeleteAccountMutation,
  useForgotPasswordMutation,
  useResetPasswordMutation,
  useChangeEmailMutation,
  useGetUserFollowingQuery,
  useFollowUserMutation,
  useUnfollowUserMutation,
  useGetVapidKeyQuery,
  useSubscribePushMutation,
  useUnsubscribePushMutation,
  useMyRecordingsQuery,
  useCreateRecordingMutation,
  useUploadRecordingChunkMutation,
  useFinalizeRecordingMutation,
  useDeleteRecordingMutation,
} = api;
