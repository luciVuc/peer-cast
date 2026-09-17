import { useEffect, useRef, useState } from "react";
import {
  CHAT_MAX_LENGTH,
  type AccessPolicy,
  type CaptureSource,
} from "@peer-cast/shared";
import { useGetConfigQuery, useGetMeQuery } from "../store/api";
import { BroadcastHost, freshPeerId, type ChatMessage } from "../lib/peer";
import { broadcastService } from "../lib/broadcastService";
import { useAppDispatch, useAppSelector } from "../store";
import {
  useStartBroadcastMutation,
  useEndBroadcastMutation,
  useUpdateStatsMutation,
  useVerifyTicketMutation,
  useSignalingTicketMutation,
  useCreateRecordingMutation,
  useUploadRecordingChunkMutation,
  useFinalizeRecordingMutation,
} from "../store/api";
import {
  broadcastStarting,
  broadcastLive,
  broadcastEnding,
  broadcastStopped,
  broadcastStatsUpdated,
} from "../store/broadcastSlice";
import { addToast, errorMessage } from "../store/toastSlice";

export function BroadcastPage() {
  const { data: cfg } = useGetConfigQuery();
  const { data: me } = useGetMeQuery();
  const dispatch = useAppDispatch();
  const [startBroadcastMutation] = useStartBroadcastMutation();
  const [endBroadcastMutation] = useEndBroadcastMutation();
  const [updateStats] = useUpdateStatsMutation();
  const [verifyTicket] = useVerifyTicketMutation();
  const [getSignalingTicket] = useSignalingTicketMutation();

  // ── Global broadcast state ──────────────────────────────────────────────
  const broadcastStatus = useAppSelector((s) => s.broadcast.status);
  const active = useAppSelector((s) => s.broadcast.active);
  const stats = useAppSelector((s) => s.broadcast.stats);

  // ── Local form state (setup fields; only relevant while idle) ───────────
  const [title, setTitle] = useState("Live broadcast");
  const [access, setAccess] = useState<AccessPolicy>("public");
  const [accessCode, setAccessCode] = useState("");
  const [canCaptureScreen, setCanCaptureScreen] = useState(
    () =>
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getDisplayMedia === "function",
  );
  const [source, setSource] = useState<CaptureSource>(() =>
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
      ? "screen"
      : "camera",
  );
  const [cameraFacingMode, setCameraFacingMode] = useState<
    "user" | "environment"
  >("user");

  const videoRef = useRef<HTMLVideoElement>(null);

  // ── P2P chat (rides the same DataConnection; server never sees content) ──
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  // ── Recording (MediaRecorder → chunked upload → replay in dashboard) ─────
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const recUploadRef = useRef<Promise<void>>(Promise.resolve());
  const [createRecordingMutation] = useCreateRecordingMutation();
  const [uploadChunk] = useUploadRecordingChunkMutation();
  const [finalizeRecording] = useFinalizeRecordingMutation();

  // Refs that always hold the latest values.  endLive() can be invoked from
  // closures created long ago (the native "Stop sharing" track-ended listener
  // registered during goLive), so it must not read component state directly.
  const broadcastIdRef = useRef<string | null>(null);
  const statusRef = useRef(broadcastStatus);
  const endingRef = useRef(false);
  useEffect(() => {
    statusRef.current = broadcastStatus;
  }, [broadcastStatus]);

  // Populate form defaults from user settings once loaded.
  useEffect(() => {
    if (me) {
      setTitle(me.settings.defaultTitle);
      setAccess(me.settings.defaultAccess);
    }
  }, [me]);

  // Android browsers generally support camera capture but not screen capture.
  // Detect the API instead of relying on user-agent sniffing so this also
  // works on embedded browsers and future platforms.
  useEffect(() => {
    const supported =
      typeof navigator.mediaDevices?.getDisplayMedia === "function";
    setCanCaptureScreen(supported);
    if (!supported) setSource("camera");
  }, []);

  // When the user returns to this page while already live, reattach the
  // stream to the preview video element (the element is re-created on mount).
  useEffect(() => {
    if (
      broadcastStatus === "live" &&
      broadcastService.stream &&
      videoRef.current
    ) {
      videoRef.current.srcObject = broadcastService.stream;
      void videoRef.current.play().catch(() => {});
    }
  }, [broadcastStatus]);

  async function toggleCamera() {
    const track = broadcastService.stream?.getVideoTracks()[0];
    if (!track) return;
    const nextFacingMode = cameraFacingMode === "user" ? "environment" : "user";
    try {
      await track.applyConstraints({ facingMode: { exact: nextFacingMode } });
      setCameraFacingMode(nextFacingMode);
    } catch {
      dispatch(
        addToast(
          "This device could not switch cameras while live. Stop and start again.",
          "warning",
        ),
      );
    }
  }

  // ── Go live ─────────────────────────────────────────────────────────────

  async function goLive() {
    if (access === "code" && !accessCode.trim()) {
      dispatch(addToast("Set an access code first.", "warning"));
      return;
    }
    if (!cfg) {
      dispatch(addToast("Server config not loaded yet.", "warning"));
      return;
    }
    dispatch(broadcastStarting());
    try {
      if (!navigator.mediaDevices) {
        throw new Error(
          "Camera and screen sharing are unavailable. Use HTTPS and allow browser permissions.",
        );
      }
      const captureSource =
        !canCaptureScreen &&
        source !== "camera" &&
        source !== "camera-only" &&
        source !== "microphone"
          ? "camera"
          : source;
      const stream =
        captureSource === "camera" ||
        captureSource === "camera-only" ||
        captureSource === "microphone"
          ? await navigator.mediaDevices.getUserMedia({
              video:
                captureSource === "microphone"
                  ? false
                  : {
                      width: { ideal: 1280 },
                      height: { ideal: 720 },
                      facingMode: { ideal: cameraFacingMode },
                    },
              audio: captureSource !== "camera-only",
            })
          : await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: 30 },
              audio: true,
            });
      broadcastService.setStream(stream);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {});
      }

      // End the broadcast automatically when the user stops sharing via the
      // browser's native "Stop sharing" button.
      stream
        .getVideoTracks()[0]
        ?.addEventListener("ended", () => void endLive());

      // Mint a short-lived signaling ticket (avoids putting JWT in the URL).
      let sigToken: string | null = null;
      try {
        const r = await getSignalingTicket().unwrap();
        sigToken = r.token;
      } catch {
        /* non-fatal */
      }

      const peerId = freshPeerId();
      const { broadcast } = await startBroadcastMutation({
        title: title.trim() || "Live broadcast",
        access,
        source: captureSource,
        peerId,
        accessCode: access === "code" ? accessCode.trim() : undefined,
      }).unwrap();
      broadcastIdRef.current = broadcast.id;

      const host = new BroadcastHost({
        cfg,
        peerId,
        stream,
        token: sigToken,
        verify: async (ticket) => {
          // Public broadcasts do not need a ticket, but the host still needs
          // a non-null identity to accept the media/data connection.
          if (access === "public") return "Viewer";
          if (!ticket) return null;
          try {
            const res = await verifyTicket({ ticket, peerId }).unwrap();
            return res.ok ? (res.username ?? null) : null;
          } catch {
            return null;
          }
        },
        onStats: (s) => {
          dispatch(broadcastStatsUpdated(s));
          void updateStats({
            id: broadcast.id,
            stats: { ...s, updatedAt: Date.now() },
          });
        },
        onChat: (msg) => setChat((prev) => [...prev.slice(-199), msg]),
        hostName: me?.user.displayName || me?.user.username || "Host",
        onError: (e) => dispatch(addToast(e.message, "error")),
      });

      broadcastService.setHost(host);
      await host.ready();

      dispatch(
        broadcastLive({
          broadcastId: broadcast.id,
          title: broadcast.title,
          access: broadcast.access as AccessPolicy,
          viewerUsername: me?.user.username ?? "",
        }),
      );
    } catch (err) {
      broadcastIdRef.current = null;
      broadcastService.cleanup();
      dispatch(broadcastStopped());
      dispatch(
        addToast(errorMessage(err, "Could not start broadcast"), "error"),
      );
    }
  }

  // ── Recording lifecycle ─────────────────────────────────────────────────

  async function startRecording() {
    const stream = broadcastService.stream;
    if (!stream || recorderRef.current) return;
    try {
      const { recording: rec } = await createRecordingMutation({
        title:
          (active?.title ?? me?.user.displayName ?? "Live broadcast") +
          " — replay",
        broadcastId: broadcastIdRef.current ?? undefined,
      }).unwrap();
      recordingIdRef.current = rec.id;
      const startedAt = Date.now();
      const streamRecorder = new MediaRecorder(stream, {
        mimeType: pickRecordingMime(),
        videoBitsPerSecond: 2_500_000,
        audioBitsPerSecond: 128_000,
      });
      recorderRef.current = streamRecorder;
      // Serialise the uploads so chunks arrive in order (MediaRecorder can
      // deliver several dataavailable events in quick succession).
      streamRecorder.addEventListener("dataavailable", (e) => {
        if (!e.data || e.data.size === 0) return;
        const id = recordingIdRef.current;
        if (!id) return;
        const blob = e.data;
        recUploadRef.current = recUploadRef.current
          .then(async () => {
            await uploadChunk({ id, body: blob }).unwrap();
          })
          .catch(() => {
            /* a failed chunk is dropped, not retried — best-effort replay */
          });
      });
      streamRecorder.addEventListener("stop", () => {
        void finishRecording(Date.now() - startedAt);
      });
      streamRecorder.start(5000); // emit a chunk every 5 s
      setRecording(true);
      dispatch(
        addToast(
          "Recording started — replay will appear in your dashboard.",
          "success",
        ),
      );
    } catch (err) {
      dispatch(
        addToast(errorMessage(err, "Could not start recording"), "error"),
      );
    }
  }

  async function finishRecording(durationMs: number) {
    const id = recordingIdRef.current;
    recordingIdRef.current = null;
    recorderRef.current = null;
    try {
      await recUploadRef.current; // flush any in-flight chunk before finalising
    } catch {
      /* ignore upload errors — finalize with what we have */
    }
    if (id) {
      try {
        await finalizeRecording({ id, durationMs }).unwrap();
      } catch {
        /* best-effort */
      }
    }
    setRecording(false);
    dispatch(
      addToast("Recording saved — find it on your dashboard.", "success"),
    );
  }

  function stopRecording() {
    const r = recorderRef.current;
    recorderRef.current = null;
    if (r && r.state !== "inactive") r.stop(); // the stop handler finalizes
  }

  // ── End broadcast ────────────────────────────────────────────────────────

  async function endLive() {
    // Guard re-entrancy: endLive may be reached both from the "End broadcast"
    // button and from the native "Stop sharing" track-ended listener firing
    // during cleanup.  Read live values from refs, never from closure state.
    if (endingRef.current) return;
    if (statusRef.current === "idle") return;
    endingRef.current = true;
    dispatch(broadcastEnding());
    const id = broadcastIdRef.current;
    broadcastIdRef.current = null;
    broadcastService.cleanup();
    if (videoRef.current) videoRef.current.srcObject = null;
    if (id) {
      try {
        await endBroadcastMutation(id).unwrap();
      } catch {
        /* best-effort; a later start/ban will force-end stale live rows */
      }
    }
    dispatch(broadcastStopped());
    endingRef.current = false;
  }

  // NOTE: no unmount cleanup here — the broadcast intentionally survives
  // navigating away from this page.  Cleanup happens only in endLive() and
  // on sign-out (Layout.tsx clears the service + dispatches broadcastStopped).

  const viewerUrl = active?.viewerUsername
    ? `${window.location.origin}/watch/${active.viewerUsername}`
    : me
      ? `${window.location.origin}/watch/${me.user.username}`
      : "";

  const isLive = broadcastStatus === "live";
  const isStarting = broadcastStatus === "starting";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      {/* ── Preview pane ─────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="card overflow-hidden">
          <div className="relative aspect-video bg-black">
            <video ref={videoRef} className="h-full w-full" muted playsInline />
            {!isLive && !isStarting && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-400">
                <span className="text-5xl">
                  {source === "microphone"
                    ? "🎙️"
                    : source === "camera" || source === "camera-only"
                      ? "📹"
                      : "🖥️"}
                </span>
                <p>
                  {source === "microphone"
                    ? "Your microphone is ready once you go live."
                    : source === "camera" || source === "camera-only"
                      ? "Your camera preview appears here once you go live."
                      : "Your screen preview appears here once you go live."}
                </p>
              </div>
            )}
            {isLive && (
              <span className="badge absolute left-3 top-3 bg-red-600 text-white">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                LIVE
              </span>
            )}
          </div>
        </div>

        {isLive && stats && (
          <div className="card grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
            <Stat label="Viewers" value={String(stats.viewers ?? 0)} />
            <Stat
              label="Bitrate"
              value={
                stats.bitrateKbps != null ? `${stats.bitrateKbps} kbps` : "—"
              }
            />
            <Stat
              label="FPS"
              value={stats.fps != null ? String(stats.fps) : "—"}
            />
            <Stat
              label="Resolution"
              value={
                stats.width && stats.height
                  ? `${stats.width}×${stats.height}`
                  : "—"
              }
            />
          </div>
        )}
      </div>

      {/* ── Control panel ─────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="card p-5">
          <h2 className="mb-4 text-lg font-bold">
            {isLive ? "You're live" : "Start a broadcast"}
          </h2>

          {!isLive ? (
            <div className="space-y-4">
              <div>
                <label className="label">Title</label>
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Capture source</label>
                <select
                  className="input"
                  value={source}
                  onChange={(e) => setSource(e.target.value as typeof source)}
                >
                  <option value="camera">Camera and microphone</option>
                  <option value="camera-only">Camera only</option>
                  <option value="microphone">Microphone only</option>
                  {canCaptureScreen && (
                    <>
                      <option value="screen">Entire screen</option>
                      <option value="window">Application window</option>
                      <option value="tab">Browser tab</option>
                    </>
                  )}
                </select>
                {!canCaptureScreen && (
                  <p className="mt-1 text-xs text-slate-400">
                    This browser does not support screen sharing, so camera mode
                    is available instead.
                  </p>
                )}
              </div>
              <div>
                <label className="label">Who can watch</label>
                <select
                  className="input"
                  value={access}
                  onChange={(e) => setAccess(e.target.value as AccessPolicy)}
                >
                  <option value="public">Public — anyone</option>
                  <option value="authenticated">
                    Members — signed-in only
                  </option>
                  <option value="code">Code — anyone with the code</option>
                </select>
              </div>
              {access === "code" && (
                <div>
                  <label className="label">Access code</label>
                  <input
                    className="input"
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    placeholder="e.g. spring-demo"
                  />
                </div>
              )}
              <button
                className="btn-primary w-full"
                onClick={goLive}
                disabled={isStarting}
              >
                {isStarting ? "Starting…" : "Go live"}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {(source === "camera" || source === "camera-only") &&
              broadcastService.stream?.getVideoTracks().length ? (
                <button
                  type="button"
                  className="btn-ghost w-full text-sm"
                  onClick={() => void toggleCamera()}
                >
                  Switch to {cameraFacingMode === "user" ? "rear" : "front"}{" "}
                  camera
                </button>
              ) : null}
              <div>
                <label className="label">Viewer link</label>
                <div className="flex gap-2">
                  <input className="input" readOnly value={viewerUrl} />
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      navigator.clipboard.writeText(viewerUrl);
                      dispatch(addToast("Viewer link copied!", "success"));
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2.5">
                <span className="text-sm text-slate-300">
                  {recording ? (
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                      Recording…
                    </span>
                  ) : (
                    "Record this broadcast (private replay)"
                  )}
                </span>
                <button
                  className={
                    recording ? "btn-danger text-sm" : "btn-ghost text-sm"
                  }
                  onClick={
                    recording ? stopRecording : () => void startRecording()
                  }
                >
                  {recording ? "Stop" : "Record"}
                </button>
              </div>
              <button className="btn-danger w-full" onClick={endLive}>
                End broadcast
              </button>
            </div>
          )}
        </div>

        <div className="card flex h-72 flex-col p-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold text-slate-200">Chat</h3>
            {isLive && (
              <span className="badge bg-ink-700 text-slate-300">P2P</span>
            )}
          </div>
          <div
            ref={chatScrollRef}
            className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 text-sm"
          >
            {chat.length === 0 && (
              <p className="text-slate-500">
                {isLive
                  ? "Viewers who connect can chat here."
                  : "Chat opens when you go live."}
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
              if (!isLive) return;
              broadcastService.host?.sendChat(chatText);
              setChatText("");
            }}
          >
            <input
              className="input min-w-0 flex-1"
              value={chatText}
              maxLength={CHAT_MAX_LENGTH}
              onChange={(e) => setChatText(e.target.value)}
              placeholder={isLive ? "Message…" : "Go live to chat"}
              disabled={!isLive}
            />
            <button
              className="btn-primary shrink-0"
              type="submit"
              disabled={!isLive || !chatText.trim()}
            >
              Send
            </button>
          </form>
        </div>

        <div className="card p-5 text-sm text-slate-400">
          <h3 className="mb-2 font-semibold text-slate-200">
            Prefer the extension?
          </h3>
          <p>
            The PeerCast browser extension can capture a specific tab (with
            audio) and broadcast in the background. Install it, sign in with the
            same account, and press its shortcut to go live — your broadcast
            appears here and in your dashboard automatically.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="text-lg font-semibold text-slate-100">{value}</div>
    </div>
  );
}

/**
 * Pick the most efficient WebM codec the browser can record. Falls back to
 * the container default if nothing more specific is supported.
 */
function pickRecordingMime(): string {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const t of types) {
    try {
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(t)
      ) {
        return t;
      }
    } catch {
      /* skip unsupported type string */
    }
  }
  return "video/webm";
}
