/**
 * Embedded viewer — stripped-down ViewerPage for <iframe> embeds.
 *
 * Route: /embed/:username
 *
 * No Layout, no header, no chat, no report button. Just the video player
 * with connection status overlays. Designed to be embedded via:
 *
 *   <iframe src="https://your-peercast.example/embed/@username"
 *           width="640" height="360" allowfullscreen
 *           allow="autoplay; camera; microphone"></iframe>
 */
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Spinner } from "../components/Spinner";
import {
  useGetConfigQuery,
  useLazyResolveSessionQuery,
  useSignalingTicketMutation,
} from "../store/api";
import { useAppSelector } from "../store";
import { connectAsViewer, type ViewerHandle } from "../lib/peer";

type Phase =
  | "resolving"
  | "offline"
  | "need-auth"
  | "need-code"
  | "connecting"
  | "playing"
  | "error";

export function EmbedPage() {
  const { username = "" } = useParams();
  const { data: cfg } = useGetConfigQuery();
  const authed = useAppSelector((s) => !!s.auth.accessToken);
  const [trigger, result] = useLazyResolveSessionQuery();
  const [getSignalingTicket] = useSignalingTicketMutation();
  const [phase, setPhase] = useState<Phase>("resolving");
  const [code, setCode] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<ViewerHandle | null>(null);
  const disposedRef = useRef(false);
  const startedRef = useRef(false);
  const resolvingRef = useRef(false);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectDelay = useRef(3000);
  const lastCodeRef = useRef<string | null>(null);

  function teardown() {
    handleRef.current?.close();
    handleRef.current = null;
  }

  function connect(
    peerId: string,
    ticket: string | null,
    sigToken: string | null,
  ) {
    if (disposedRef.current || !cfg) return;
    teardown();
    setPhase("connecting");
    const handle = connectAsViewer({
      cfg,
      targetPeerId: peerId,
      ticket,
      token: sigToken,
      onStream: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
        reconnectDelay.current = 3000;
        setPhase("playing");
      },
      onError: () => {
        if (handleRef.current !== handle) return;
        setPhase("error");
      },
      onClose: () => {
        if (disposedRef.current || handleRef.current !== handle) return;
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, 30_000);
        setPhase("resolving");
        reconnectTimer.current = window.setTimeout(
          () => void resolve(lastCodeRef.current ?? undefined),
          delay,
        );
      },
    });
    handleRef.current = handle;
  }

  async function resolve(withCode?: string) {
    if (disposedRef.current || resolvingRef.current) return;
    resolvingRef.current = true;
    try {
      setPhase("resolving");
      const res = await trigger({ username, code: withCode });
      if (disposedRef.current) return;
      if (res.error) {
        const status = (res.error as { status?: number }).status;
        if (status === 404) setPhase("offline");
        else if (status === 401) setPhase(authed ? "need-code" : "need-auth");
        else if (status === 403) setPhase("need-code");
        else setPhase("error");
        return;
      }
      if (!res.data?.peerId) {
        setPhase(authed ? "need-code" : "need-auth");
        return;
      }
      if (withCode) lastCodeRef.current = withCode;
      let sigToken: string | null = null;
      if (authed) {
        try {
          sigToken = (await getSignalingTicket().unwrap()).token;
        } catch {
          /* ok */
        }
      }
      if (disposedRef.current) return;
      connect(res.data.peerId, res.data.ticket, sigToken);
    } finally {
      resolvingRef.current = false;
    }
  }

  useEffect(() => {
    if (!username || !cfg) return;
    disposedRef.current = false;
    if (!startedRef.current) {
      startedRef.current = true;
      void resolve();
    }
    return () => {
      disposedRef.current = true;
      startedRef.current = false;
      resolvingRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, cfg]);

  const title = result.data?.broadcast.title ?? `@${username}`;

  return (
    <div className="relative flex h-full w-full flex-col bg-black">
      {/* The video element fills the entire embed */}
      <video
        ref={videoRef}
        className="h-full w-full"
        playsInline
        controls
        muted={false}
        aria-label={title}
      />

      {/* Overlay for non-playing states */}
      {phase !== "playing" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900/95 p-4 text-center">
          {phase === "resolving" && <Spinner label="Finding broadcast…" />}
          {phase === "connecting" && <Spinner label="Connecting…" />}

          {phase === "offline" && (
            <>
              <span className="text-4xl">🌙</span>
              <p className="text-sm text-slate-300">@{username} is not live</p>
            </>
          )}

          {phase === "need-auth" && (
            <>
              <span className="text-4xl">🔒</span>
              <p className="text-sm text-slate-300">Sign in to watch</p>
            </>
          )}

          {phase === "need-code" && (
            <form
              className="w-full max-w-xs space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void resolve(code);
              }}
            >
              <span className="text-4xl">🔑</span>
              <p className="text-sm text-slate-300">Enter access code</p>
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Access code"
                  autoFocus
                />
                <button className="btn-primary" type="submit">
                  Watch
                </button>
              </div>
            </form>
          )}

          {phase === "error" && (
            <>
              <span className="text-4xl">⚠️</span>
              <p className="text-sm text-slate-300">Connection failed</p>
              <button
                className="btn-ghost text-sm"
                onClick={() => void resolve()}
              >
                Retry
              </button>
            </>
          )}
        </div>
      )}

      {/* Live badge */}
      {phase === "playing" && (
        <span className="badge absolute left-3 top-3 bg-red-600 text-white">
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-white"
            aria-hidden="true"
          />
          LIVE
        </span>
      )}
    </div>
  );
}
