import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CHAT_MAX_LENGTH } from "@peer-cast/shared";
import { IllustratedMessage } from "../components/IllustratedMessage";
import { Modal } from "../components/Modal";
import { Spinner } from "../components/Spinner";
import { Avatar } from "../components/Avatar";
import {
  useCreateReportMutation,
  useFollowUserMutation,
  useGetConfigQuery,
  useGetUserFollowingQuery,
  useLazyResolveSessionQuery,
  useListLiveQuery,
  useSignalingTicketMutation,
  useUnfollowUserMutation,
} from "../store/api";
import { useAppSelector } from "../store";
import {
  connectAsViewer,
  packChat,
  type ChatMessage,
  type ViewerHandle,
} from "../lib/peer";

type Phase =
  | "resolving"
  | "offline"
  | "need-auth"
  | "need-code"
  | "connecting"
  | "playing"
  | "error";

/**
 * How long the viewer keeps auto-retrying after a stream drops. A host
 * restarting normally takes seconds, so a generous window covers the real case
 * — but an open tab must never poll forever: `/api/sessions` is rate limited,
 * so an unbounded loop would eventually spend that budget on a host that may
 * never return, then strand the viewer on a hard 429. Once the window is spent
 * we stop and leave the Retry button to the user.
 */
const RETRY_WINDOW_MS = 5 * 60_000;

export function ViewerPage() {
  const { username = "" } = useParams();
  const { data: cfg } = useGetConfigQuery();
  const authed = useAppSelector((s) => !!s.auth.accessToken);
  const viewerName = useAppSelector((s) => s.auth.user?.displayName);
  const [trigger, result] = useLazyResolveSessionQuery();
  const [getSignalingTicket] = useSignalingTicketMutation();
  const [phase, setPhase] = useState<Phase>("resolving");
  const [code, setCode] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ViewerHandle | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  /** Reconnect delay, doubles on each failure up to 30 s (exponential backoff). */
  const reconnectDelay = useRef(3000);
  /** Last access code that successfully resolved, so reconnects re-send it. */
  const lastCodeRef = useRef<string | null>(null);
  /** True once we have actually received media for this username. Distinguishes
   *  "the stream I was watching dropped" (keep polling for the host to come
   *  back) from "I arrived and nobody is live" (stay put, retry manually). */
  const wasLiveRef = useRef(false);
  /** Deadline for the current auto-retry window (see RETRY_WINDOW_MS). Reset
   *  whenever we receive media or the user asks for a fresh resolve. */
  const retryDeadlineRef = useRef(0);
  /** True once the component has unmounted — stops any in-flight reconnects. */
  const disposedRef = useRef(false);
  /** Guards against duplicate initial resolves (React 18 StrictMode double-invoke). */
  const startedRef = useRef(false);
  /** Prevents concurrent resolve() calls (e.g. Retry click + reconnect timer). */
  const resolvingRef = useRef(false);

  /** Mint a signaling ticket for authenticated viewers (avoids JWT in URL). */
  async function mintSigToken(): Promise<string | null> {
    if (!authed) return null;
    try {
      const res = await getSignalingTicket().unwrap();
      return res.token;
    } catch {
      return null;
    }
  }

  /** Tear down any existing peer connection (without scheduling a reconnect). */
  function teardown() {
    const h = handleRef.current;
    handleRef.current = null;
    if (h) {
      // Detach so its close event doesn't trigger our reconnect logic.
      h.close();
    }
  }

  /**
   * Re-resolve after the current backoff delay (3 s, doubling to a 30 s cap).
   * Reconnects re-send the last access code so a members/code stream doesn't
   * bounce back to the code prompt. Idempotent — clears any pending timer so a
   * manual Retry plus an armed timer can't stack up duplicate polls.
   *
   * A no-op once RETRY_WINDOW_MS is spent, which is what stops this loop from
   * polling forever. When the window is spent we drop to the "offline" phase
   * so the Retry button appears: the caller sets "resolving" *before* calling
   * us, so returning silently strands the viewer on a permanent spinner with
   * no recovery but a page reload.
   */
  function scheduleReconnect() {
    if (disposedRef.current) return;
    if (Date.now() >= retryDeadlineRef.current) {
      // Window spent. Surface the Retry button instead of leaving the caller
      // on whatever phase it chose — onClose sets "resolving" *before* calling
      // us, so returning silently here strands the viewer on a permanent
      // "Finding broadcast…" spinner with no way out but a page reload.
      setPhase("offline");
      return;
    }
    const delay = reconnectDelay.current;
    reconnectDelay.current = Math.min(delay * 2, 30_000);
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = window.setTimeout(
      () => void resolve(lastCodeRef.current ?? undefined, true),
      delay,
    );
  }

  /**
   * Establish the P2P connection imperatively (NOT via a React effect, so a
   * re-render / StrictMode re-invoke / phase change can never tear down a
   * live peer mid-negotiation).  Called from resolve() once a peerId is known.
   */
  function connect(
    peerId: string,
    ticket: string | null,
    sigToken: string | null,
  ) {
    if (disposedRef.current || !cfg) return;
    // Replace any prior handle first.
    teardown();
    setPhase("connecting");
    const handle = connectAsViewer({
      cfg,
      targetPeerId: peerId,
      ticket,
      token: sigToken,
      viewerName,
      onStream: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
        wasLiveRef.current = true;
        reconnectDelay.current = 3000; // successful stream — reset backoff
        // A fresh stream means a fresh outage can be waited out.
        retryDeadlineRef.current = Date.now() + RETRY_WINDOW_MS;
        setPhase("playing");
      },
      onError: (err) => {
        // Only surface as a hard error if this is still the active handle.
        if (handleRef.current !== handle) return;
        setErrMsg(err.message || "Connection failed");
        setPhase("error");
      },
      onClose: () => {
        // Connection dropped. Ignore if this handle was already replaced or the
        // component is gone.  Otherwise re-resolve with exponential backoff.
        if (disposedRef.current || handleRef.current !== handle) return;
        setPhase("resolving");
        scheduleReconnect();
      },
      onChat: (msg) => setChat((prev) => [...prev.slice(-199), msg]),
    });
    handleRef.current = handle;
  }

  // Resolve the session (optionally with an access code), then connect.
  // `background` keeps the current message on screen while we poll — used by
  // the auto-retry loop so a viewer waiting on a host who is restarting isn't
  // flashed with a spinner on every attempt.
  async function resolve(withCode?: string, background = false) {
    if (disposedRef.current || resolvingRef.current) return;
    resolvingRef.current = true;
    try {
      if (!background) {
        setPhase("resolving");
        // A user-initiated resolve (first load or Retry) always gets a full
        // auto-retry window from here.
        retryDeadlineRef.current = Date.now() + RETRY_WINDOW_MS;
      }
      const res = await trigger({ username, code: withCode });
      if (disposedRef.current) return;
      if (res.error) {
        const status = (res.error as { status?: number }).status;
        if (status === 404) {
          setPhase("offline");
          // If we were watching a stream that just dropped, the host is free to
          // go live again at any moment — keep polling (quietly, backing off to
          // 30 s) so the viewer reconnects on its own instead of being stranded
          // on a dead "not live" screen. A viewer who arrived to an offline host
          // (wasLiveRef === false) stays put and uses the Retry button.
          if (wasLiveRef.current) scheduleReconnect();
          return;
        }
        if (status === 401) {
          // Distinguish "you must sign in" from "you must enter a code". The
          // server marks a code-gated 401 with `needsCode`; a plain 401 means
          // the session is gone or never existed. Inferring the code prompt
          // from `authed` asked mid-watch viewers for a code that does not
          // exist on a members-only stream — a prompt that can never succeed.
          const needsCode = (
            res.error as { data?: { needsCode?: boolean } } | undefined
          )?.data?.needsCode;
          setPhase(needsCode ? "need-code" : "need-auth");
        } else if (status === 403) {
          setPhase("need-code");
          setErrMsg("Incorrect access code.");
        } else setPhase("error");
        return;
      }
      const data = res.data!;
      if (data.needsCode) {
        setPhase("need-code");
        return;
      }
      if (!data.peerId) {
        // A 200 without a peerId is not an access problem — there is nothing
        // to prompt for. Report it as an error rather than showing a code
        // field the viewer cannot satisfy.
        setPhase(authed ? "error" : "need-auth");
        return;
      }
      // Remember the code that unlocked this session so automatic reconnects
      // (which re-resolve) can re-send it instead of bouncing back to login.
      if (withCode) lastCodeRef.current = withCode;
      // Mint the signaling ticket, then connect imperatively.
      const sigToken = await mintSigToken();
      if (disposedRef.current) return;
      connect(data.peerId, data.ticket, sigToken);
    } finally {
      resolvingRef.current = false;
    }
  }

  // Initial resolve + single cleanup on unmount. Empty-ish deps so this runs
  // once per username/cfg; a ref guard neutralises StrictMode's double-invoke.
  useEffect(() => {
    if (!username || !cfg) return;
    disposedRef.current = false;
    if (!startedRef.current) {
      startedRef.current = true;
      void resolve();
    }
    return () => {
      // Real unmount (or username/cfg change): stop everything.
      disposedRef.current = true;
      startedRef.current = false;
      resolvingRef.current = false;
      // A different username is a different host — don't inherit its "keep
      // polling" state.
      wasLiveRef.current = false;
      retryDeadlineRef.current = 0;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, cfg]);

  // Keep the newest line in view as chat streams in.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const owner = result.data?.broadcast.owner;
  const title = result.data?.broadcast.title;
  const broadcastId = result.data?.broadcast.id;
  // Live stats overlay: follow the global live feed (no extra resolve), so the
  // viewer count + bitrate stay current while watching without re-resolving.
  // For non-public/non-discoverable broadcasts the live feed won't include
  // the broadcast, so fall back to stats from the resolve response.
  // This poll exists only to refine the viewer-count overlay; `result.data.stats`
  // below is already the correct value from the resolve response. Gate it on
  // actually playing so viewers sitting on the code prompt, an error, or a
  // dead host are not polling the feed at all, and drop to 30 s otherwise.
  const { data: liveFeed } = useListLiveQuery(undefined, {
    pollingInterval: 30000,
    skip: phase !== "playing",
  });
  const liveStats =
    liveFeed?.broadcasts.find((b) => b.owner.username === username)?.stats ??
    result.data?.stats;
  const [createReport] = useCreateReportMutation();
  const [reported, setReported] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reporting, setReporting] = useState(false);

  // Following drives "followed user goes live" push notifications.
  const myUsername = useAppSelector((s) => s.auth.user?.username);
  const [followUser] = useFollowUserMutation();
  const [unfollowUser] = useUnfollowUserMutation();
  const { data: followingData, isLoading: followingLoading } =
    useGetUserFollowingQuery(username, { skip: !authed });
  const following = followingData?.following ?? false;
  const isOwnStream = authed && myUsername === owner?.username;

  async function toggleFollow() {
    if (!authed) return;
    try {
      if (following) await unfollowUser(username).unwrap();
      else await followUser(username).unwrap();
    } catch {
      /* transient — the query refetches and the toggle continues next click */
    }
  }

  async function submitReport() {
    if (!reportReason.trim()) return;
    setReporting(true);
    try {
      await createReport({
        targetUsername: username,
        broadcastId: broadcastId ?? null,
        reason: reportReason.trim(),
      }).unwrap();
      setReported(true);
    } catch {
      /* ignore */
    } finally {
      setReporting(false);
      setShowReportModal(false);
      setReportReason("");
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-3">
        <Link to="/" className="btn-ghost">
          ← Back
        </Link>
        <h1 className="text-xl font-bold">@{username}</h1>
        {phase === "playing" && (
          <span className="badge bg-red-600 text-white">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            LIVE
          </span>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="relative aspect-video bg-black">
          <video
            ref={videoRef}
            className="h-full w-full"
            playsInline
            controls
            muted={false}
          />
          {phase === "playing" && liveStats && (
            <span className="badge absolute right-3 top-3 bg-black/60 text-slate-100">
              👁 {liveStats.viewers}
              {liveStats.bitrateKbps ? ` · ${liveStats.bitrateKbps} kbps` : ""}
            </span>
          )}
          {phase !== "playing" && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink-900/95">
              {phase === "resolving" && <Spinner label="Finding broadcast…" />}
              {phase === "connecting" && (
                <Spinner label="Connecting peer-to-peer…" />
              )}
              {phase === "offline" && (
                <IllustratedMessage
                  icon="🌙"
                  title={`@${username} isn't live`}
                  description="There's no active broadcast right now. Try again later."
                  action={
                    <button className="btn-primary" onClick={() => resolve()}>
                      Retry
                    </button>
                  }
                />
              )}
              {phase === "need-auth" && (
                <IllustratedMessage
                  icon="🔒"
                  title="Members-only broadcast"
                  description="Sign in to watch this stream."
                  action={
                    <Link className="btn-primary" to="/login">
                      Sign in
                    </Link>
                  }
                />
              )}
              {phase === "need-code" && (
                <div className="w-full max-w-sm p-6 text-center">
                  <div className="mb-3 text-5xl">🔑</div>
                  <h2 className="text-lg font-semibold">
                    Access code required
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    Enter the code shared by the broadcaster.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <input
                      className="input"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="Access code"
                    />
                    <button
                      className="btn-primary"
                      onClick={() => resolve(code)}
                      disabled={!code}
                    >
                      Watch
                    </button>
                  </div>
                  {errMsg && (
                    <p className="mt-2 text-sm text-red-400">{errMsg}</p>
                  )}
                </div>
              )}
              {phase === "error" && (
                <IllustratedMessage
                  icon="⚠️"
                  title="Something went wrong"
                  description={
                    errMsg || "The connection could not be established."
                  }
                  action={
                    <button className="btn-primary" onClick={() => resolve()}>
                      Try again
                    </button>
                  }
                />
              )}
            </div>
          )}
        </div>

        {owner && (
          <div className="flex items-center gap-3 p-4">
            <Avatar user={owner} size={44} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{title}</div>
              <div className="truncate text-sm text-slate-400">
                {owner.displayName} · @{owner.username}
              </div>
            </div>
            {owner && authed && !isOwnStream && (
              <button
                className={`btn shrink-0 ${following ? "btn-ghost" : "btn-primary"}`}
                onClick={() => void toggleFollow()}
                disabled={followingLoading}
                title={
                  following
                    ? "You'll get a push notification when this user goes live"
                    : "Follow to be notified when this user goes live"
                }
              >
                {followingLoading
                  ? "…"
                  : following
                    ? "✓ Following"
                    : "+ Follow"}
              </button>
            )}
            <button
              className="btn-ghost shrink-0"
              onClick={() => setShowReportModal(true)}
              disabled={reported}
              title="Report this broadcast"
            >
              {reported ? "Reported ✓" : "⚑ Report"}
            </button>
          </div>
        )}
      </div>

      {showReportModal && (
        <Modal
          title={`Report @${username}`}
          onClose={() => {
            setShowReportModal(false);
            setReportReason("");
          }}
          actions={
            <>
              <button
                className="btn-ghost"
                onClick={() => {
                  setShowReportModal(false);
                  setReportReason("");
                }}
              >
                Cancel
              </button>
              <button
                className="btn-danger"
                disabled={reporting || !reportReason.trim()}
                onClick={submitReport}
              >
                {reporting ? "Sending…" : "Submit report"}
              </button>
            </>
          }
        >
          <p className="mb-3 text-sm text-slate-400">
            Describe the problem with this broadcast. Reports are reviewed by
            admins.
          </p>
          <label className="label" htmlFor="vp-report-reason">
            Reason
          </label>
          <textarea
            id="vp-report-reason"
            className="input"
            rows={3}
            autoFocus
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value)}
            placeholder="e.g. abusive content, spam…"
          />
        </Modal>
      )}

      <div className="card mt-4 flex flex-col p-4">
        <button
          type="button"
          className="mb-2 flex w-full items-center justify-between text-left"
          onClick={() => setChatOpen((o) => !o)}
          aria-expanded={chatOpen}
        >
          <h2 className="text-lg font-bold">Chat</h2>
          <div className="flex items-center gap-2">
            {phase === "playing" && (
              <span className="badge bg-ink-700 text-slate-300">P2P</span>
            )}
            <span className="text-xs text-slate-500 sm:hidden">
              {chatOpen ? "▾" : "▸"}
            </span>
          </div>
        </button>
        {chatOpen && (
          <>
            <div
              ref={chatScrollRef}
              className="min-h-0 h-56 max-h-[50vh] space-y-2 overflow-y-auto pr-1 text-sm"
            >
              {chat.length === 0 && (
                <p className="text-slate-500">
                  {phase === "playing"
                    ? "No messages yet. Say hello!"
                    : "Messages appear here once you're connected."}
                </p>
              )}
              {chat.map((m) => (
                <div key={m.id} className="break-words">
                  <span className="font-semibold text-slate-200">
                    {m.from}:
                  </span>{" "}
                  <span className="text-slate-300">{m.text}</span>
                </div>
              ))}
            </div>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (phase !== "playing") return;
                handleRef.current?.sendChat(chatText);
                // The host relays to *other* viewers only — echo locally so the
                // sender sees their own line too.
                setChat((prev) => [
                  ...prev.slice(-199),
                  packChat(viewerName || "Viewer", chatText.trim()),
                ]);
                setChatText("");
              }}
            >
              <input
                className="input min-w-0 flex-1"
                value={chatText}
                maxLength={CHAT_MAX_LENGTH}
                onChange={(e) => setChatText(e.target.value)}
                placeholder={
                  phase === "playing" ? "Message…" : "Connect to send a message"
                }
                disabled={phase !== "playing"}
              />
              <button
                className="btn-primary shrink-0"
                type="submit"
                disabled={phase !== "playing" || !chatText.trim()}
              >
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
