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
  const videoRef = useRef<HTMLVideoElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ViewerHandle | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  /** Reconnect delay, doubles on each failure up to 30 s (exponential backoff). */
  const reconnectDelay = useRef(3000);
  /** Last access code that successfully resolved, so reconnects re-send it. */
  const lastCodeRef = useRef<string | null>(null);
  /** True once the component has unmounted — stops any in-flight reconnects. */
  const disposedRef = useRef(false);
  /** Guards against duplicate initial resolves (React 18 StrictMode double-invoke). */
  const startedRef = useRef(false);

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
        reconnectDelay.current = 3000; // successful stream — reset backoff
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
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, 30_000);
        setPhase("resolving");
        reconnectTimer.current = window.setTimeout(
          () => void resolve(lastCodeRef.current ?? undefined),
          delay,
        );
      },
      onChat: (msg) => setChat((prev) => [...prev.slice(-199), msg]),
    });
    handleRef.current = handle;
  }

  // Resolve the session (optionally with an access code), then connect.
  async function resolve(withCode?: string) {
    if (disposedRef.current) return;
    setPhase("resolving");
    const res = await trigger({ username, code: withCode });
    if (disposedRef.current) return;
    if (res.error) {
      const status = (res.error as { status?: number }).status;
      if (status === 404) setPhase("offline");
      else if (status === 401) setPhase(authed ? "need-code" : "need-auth");
      else if (status === 403) {
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
      setPhase(authed ? "need-code" : "need-auth");
      return;
    }
    // Remember the code that unlocked this session so automatic reconnects
    // (which re-resolve) can re-send it instead of bouncing back to login.
    if (withCode) lastCodeRef.current = withCode;
    // Mint the signaling ticket, then connect imperatively.
    const sigToken = await mintSigToken();
    if (disposedRef.current) return;
    connect(data.peerId, data.ticket, sigToken);
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
  const { data: liveFeed } = useListLiveQuery(undefined, {
    pollingInterval: 15000,
  });
  const liveStats = liveFeed?.broadcasts.find(
    (b) => b.owner.username === username,
  )?.stats;
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
          <label className="label">Reason</label>
          <textarea
            className="input"
            rows={3}
            autoFocus
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value)}
            placeholder="e.g. abusive content, spam…"
          />
        </Modal>
      )}

      <div className="card mt-4 flex h-72 flex-col p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-bold">Chat</h2>
          {phase === "playing" && (
            <span className="badge bg-ink-700 text-slate-300">P2P</span>
          )}
        </div>
        <div
          ref={chatScrollRef}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 text-sm"
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
              <span className="font-semibold text-slate-200">{m.from}:</span>{" "}
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
      </div>
    </div>
  );
}
