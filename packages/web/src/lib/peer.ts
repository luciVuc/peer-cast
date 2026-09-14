import Peer, { type DataConnection, type MediaConnection } from "peerjs";
import { CHAT_MAX_LENGTH, type RuntimeConfig } from "@peer-cast/shared";

/**
 * Thin wrapper around PeerJS for both roles:
 *   - Viewer: `connectAsViewer` dials a broadcaster's peer id and resolves the
 *     inbound MediaStream.
 *   - Broadcaster: `BroadcastHost` registers a peer, answers incoming calls
 *     with a local stream, verifies access tickets, and samples bitrate.
 *
 * Signaling always uses the current origin (works behind the Vite dev proxy
 * and in the single-container deployment); only the path + key come from the
 * server runtime config.
 */

/**
 * PeerJS 1.5.x processes signaling messages concurrently via async WebSocket
 * handlers. When ANSWER and CANDIDATE arrive in quick succession (e.g. across
 * a WebSocket proxy), `addIceCandidate()` can be called before
 * `setRemoteDescription(answer)` resolves. Chrome throws
 * `InvalidStateError: Cannot add ICE candidate when there is no remote offer`,
 * PeerJS treats it as a fatal error and immediately destroys the connection.
 *
 * This one-time "perfect negotiation" patch queues `addIceCandidate` calls
 * that arrive before a remote description is set, then flushes them after
 * `setRemoteDescription` completes.  Applied once at module-load time.
 */
(function patchRtcIceCandidateQueue() {
  // Non-browser environments (Node unit tests) skip the patch.
  if (typeof RTCPeerConnection === "undefined") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = RTCPeerConnection.prototype as any;
  const origSRD = proto.setRemoteDescription as (
    ...args: unknown[]
  ) => Promise<void>;
  const origAIC = proto.addIceCandidate as (
    candidate?: unknown,
  ) => Promise<void>;

  proto.setRemoteDescription = async function (...args: unknown[]) {
    const result = await origSRD.apply(this, args);
    const queue = (this as { __icq?: unknown[] }).__icq;
    if (queue?.length) {
      (this as { __icq?: unknown[] }).__icq = [];
      for (const c of queue) {
        await origAIC.call(this, c).catch(() => {
          /* swallow errors on queued candidates */
        });
      }
    }
    return result;
  };

  proto.addIceCandidate = async function (candidate?: unknown) {
    if (candidate == null) return origAIC.call(this);
    if (!(this as RTCPeerConnection).remoteDescription) {
      const self = this as { __icq?: unknown[] };
      self.__icq = self.__icq ?? [];
      self.__icq.push(candidate);
      return;
    }
    return origAIC.call(this, candidate);
  };
})();

function peerOptions(cfg: RuntimeConfig, token?: string | null) {
  const loc = window.location;
  const secure = loc.protocol === "https:";
  const port = loc.port ? Number(loc.port) : secure ? 443 : 80;
  return {
    host: loc.hostname,
    port,
    path: cfg.signal.path,
    key: cfg.signal.key,
    secure,
    // Passed to the self-hosted signaling server for auth-gated signaling;
    // banned accounts are evicted at the handshake.
    token: token ?? undefined,
    config: cfg.signal.iceServers?.length
      ? { iceServers: cfg.signal.iceServers }
      : undefined,
  } as const;
}

/** Generate a fresh, unguessable peer id per broadcast. */
export function freshPeerId(): string {
  return "pc-" + crypto.randomUUID().replace(/-/g, "");
}

// ─── Chat (P2P over the PeerJS DataConnection) ──────────────────────────

/** One chat line exchanged over the data channel. Messages are ride-along —
 * the server never sees or stores chat content (rendezvous-only by design). */
export interface ChatMessage {
  kind: "chat";
  id: string;
  from: string;
  text: string;
  ts: number;
}

export function packChat(from: string, text: string): ChatMessage {
  return { kind: "chat", id: crypto.randomUUID(), from, text, ts: Date.now() };
}

/** Parse a chat line received on the wire. Returns null for anything that is
 * not a well-formed chat message (e.g. future protocol frames). */
export function unpackChat(data: unknown): ChatMessage | null {
  if (typeof data !== "string") return null;
  try {
    const raw = JSON.parse(data) as Record<string, unknown>;
    if (
      raw.kind === "chat" &&
      typeof raw.text === "string" &&
      typeof raw.from === "string"
    ) {
      return {
        kind: "chat",
        id: typeof raw.id === "string" ? raw.id : crypto.randomUUID(),
        from: raw.from,
        text: raw.text,
        ts: typeof raw.ts === "number" ? raw.ts : Date.now(),
      };
    }
  } catch {
    /* not JSON / not chat — ignore */
  }
  return null;
}

/** Re-attribute + clamp a chat line before relaying it. `verifiedName` is the
 *  identity resolved from the viewer's access ticket — the wire-supplied
 *  `from` field is always discarded here (it is client-controlled and could
 *  be forged to impersonate the host or another viewer). */
export function sanitizeChat(
  raw: ChatMessage,
  verifiedName?: string,
): ChatMessage {
  return {
    ...raw,
    from: verifiedName || "Viewer",
    text: raw.text.slice(0, CHAT_MAX_LENGTH),
  };
}

// ─── Viewer ─────────────────────────────────────────────────────────────

export interface ViewerHandle {
  peer: Peer;
  call: MediaConnection;
  close: () => void;
  /** Queue an outbound chat line over the data channel. */
  sendChat: (text: string) => void;
}

/** Generate a minimal MediaStream for the viewer to pass to peer.call().
 * Must include BOTH video and audio tracks so that the SDP offer contains
 * both m=video and m=audio lines.
 *
 * Without audio in the offer, PeerJS on the broadcaster side adds the
 * broadcaster's audio tracks to the RTCPeerConnection before createAnswer().
 * Chromium (Unified Plan) then inserts an extra m=audio line into the answer
 * SDP — but RFC 3264 forbids an answer from having more m-lines than the
 * offer.  Chrome fires a negotiation error and immediately closes the call.
 *
 * We use AudioContext with `sinkId:{type:'none'}` (Chrome 110+) so the
 * context processes audio without touching any hardware device.  If that
 * API isn't available we fall back to a regular AudioContext (which may log
 * a benign console error in headless/CI environments but still produces a
 * valid audio track for SDP negotiation).
 */
function dummyStream(): MediaStream {
  const canvas = Object.assign(document.createElement("canvas"), {
    width: 16,
    height: 16,
  });
  canvas.getContext("2d")?.fillRect(0, 0, 16, 16);
  const video = (
    canvas as HTMLCanvasElement & {
      captureStream(fps?: number): MediaStream;
    }
  ).captureStream(1);

  // Add a silent audio track so the SDP offer includes m=audio.  Use the
  // virtual sink API to avoid requiring actual audio hardware.
  try {
    const opts: AudioContextOptions = {};
    // AudioContext.setSinkId / sinkId option is Chrome 110+
    // type-cast because the TS lib may not have it yet.
    if ("setSinkId" in AudioContext.prototype) {
      (opts as Record<string, unknown>).sinkId = { type: "none" };
    }
    const actx = new AudioContext(opts);
    const dest = actx.createMediaStreamDestination();
    const osc = actx.createOscillator();
    osc.frequency.value = 0; // silence
    osc.connect(dest);
    osc.start();
    dest.stream.getAudioTracks().forEach((t) => video.addTrack(t));
  } catch {
    /* audio not available in this environment — offer will be video-only;
     * if that causes a negotiation error it will surface as a connection
     * failure which the viewer error UI already handles. */
  }

  return video;
}

export interface ConnectAsViewerOptions {
  cfg: RuntimeConfig;
  targetPeerId: string;
  ticket: string | null;
  /** JWT passed to the signaling server for auth-gated signaling. */
  token?: string | null;
  /** Display name sent to the host so chat lines are attributed. */
  viewerName?: string;
  onStream: (stream: MediaStream) => void;
  onError: (err: Error) => void;
  onClose: () => void;
  onChat?: (msg: ChatMessage) => void;
}

export function connectAsViewer(options: ConnectAsViewerOptions): ViewerHandle {
  const { cfg, targetPeerId, ticket } = options;
  const peer = new Peer(peerOptions(cfg, options.token ?? undefined));
  let call: MediaConnection | null = null;
  let data: DataConnection | null = null;
  let chatQueue: string[] = [];

  const handle: ViewerHandle = {
    peer,
    get call() {
      return call as MediaConnection;
    },
    close() {
      try {
        data?.close();
      } catch {
        /* noop */
      }
      try {
        call?.close();
      } catch {
        /* noop */
      }
      peer.destroy();
    },
    sendChat(text: string) {
      const line = packChat(
        options.viewerName || "Viewer",
        text.slice(0, CHAT_MAX_LENGTH),
      );
      if (!line.text.trim()) return;
      const payload = JSON.stringify(line);
      if (data?.open) {
        data.send(payload);
      } else {
        chatQueue.push(payload);
      }
    },
  };

  peer.on("open", () => {
    call = peer.call(targetPeerId, dummyStream(), {
      metadata: { ticket, viewerPeerId: peer.id },
    });
    call.on("stream", (remote) => options.onStream(remote));
    call.on("close", options.onClose);
    call.on("error", (e) => options.onError(e as Error));

    // Chat rides the same P2P link on a DataConnection.  Metadata mirrors the
    // media call so the host can run the same two-gate ticket verification.
    data = peer.connect(targetPeerId, {
      metadata: {
        ticket,
        viewerPeerId: peer.id,
        name: options.viewerName ?? null,
      },
    });
    data.on("open", () => {
      for (const queued of chatQueue) data?.send(queued);
      chatQueue = [];
    });
    data.on("data", (d: unknown) => {
      const msg = unpackChat(d);
      if (msg) options.onChat?.(msg);
    });
    data.on("error", () => {
      /* chat is best-effort; media errors already surface via call */
    });
  });

  peer.on("error", (e) => options.onError(e as Error));
  return handle;
}

// ─── Broadcaster host ────────────────────────────────────────────────────

export interface HostStats {
  viewers: number;
  bitrateKbps: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  /** Cumulative accepted viewer connections since the broadcast started. */
  totalConnections: number;
}

export interface BroadcastHostOptions {
  cfg: RuntimeConfig;
  peerId: string;
  stream: MediaStream;
  /** JWT passed to the signaling server for auth-gated signaling. */
  token?: string | null;
  /** Verify a viewer's ticket; return the display name to attribute chat to,
   *  or null/throw to reject the connection. The returned name is the ONLY
   *  trusted attribution — wire-level `from` fields are always ignored so a
   *  viewer can't spoof the host or another viewer. */
  verify: (
    ticket: string | null,
    viewerPeerId: string,
  ) => Promise<string | null>;
  onStats: (stats: HostStats) => void;
  onError?: (err: Error) => void;
  /** Called with every chat line the host sees (their own + relayed viewers). */
  onChat?: (msg: ChatMessage) => void;
  /** Display name used for chat lines the host sends. */
  hostName?: string;
}

export class BroadcastHost {
  private peer: Peer;
  private calls = new Set<MediaConnection>();
  private dataConns = new Set<DataConnection>();
  /** Verified display name per remote peer id (chat attribution). */
  private names = new Map<string, string>();
  private baselines = new Map<string, { bytes: number; ts: number }>();
  private timer: number | null = null;
  private opts: BroadcastHostOptions;
  /** Monotonically-increasing count of all accepted viewer connections. */
  private totalConnections = 0;

  constructor(opts: BroadcastHostOptions) {
    this.opts = opts;
    this.peer = new Peer(opts.peerId, peerOptions(opts.cfg, opts.token));
    this.peer.on("call", (call) => void this.handleCall(call));
    this.peer.on("connection", (conn) => void this.handleConn(conn));
    this.peer.on("error", (e) => opts.onError?.(e as Error));
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.peer.on("open", () => resolve());
      this.peer.on("error", (e) => reject(e));
    });
  }

  private async handleCall(call: MediaConnection) {
    const meta = (call.metadata ?? {}) as {
      ticket?: string | null;
      viewerPeerId?: string;
    };
    const name = await this.opts.verify(
      meta.ticket ?? null,
      meta.viewerPeerId ?? call.peer,
    );
    if (name == null) {
      call.close();
      return;
    }
    if (call.peer) this.names.set(call.peer, name);
    call.answer(this.opts.stream);
    this.calls.add(call);
    this.totalConnections++;
    call.on("close", () => this.calls.delete(call));
    call.on("error", () => this.calls.delete(call));
    if (this.timer == null) this.startSampling();
  }

  /** Accept the viewer's chat DataConnection (same ticket gate as media). */
  private async handleConn(conn: DataConnection) {
    const meta = (conn.metadata ?? {}) as {
      ticket?: string | null;
      viewerPeerId?: string;
    };
    const name = await this.opts.verify(
      meta.ticket ?? null,
      meta.viewerPeerId ?? conn.peer,
    );
    if (name == null) {
      conn.close();
      return;
    }
    if (conn.peer) this.names.set(conn.peer, name);
    this.dataConns.add(conn);
    conn.on("close", () => {
      this.dataConns.delete(conn);
      if (conn.peer) this.names.delete(conn.peer);
    });
    conn.on("error", () => this.dataConns.delete(conn));
    conn.on("data", (d: unknown) => this.handleChat(conn, d));
  }

  private handleChat(fromConn: DataConnection, data: unknown) {
    const raw = unpackChat(data);
    if (!raw) return;
    // Attribution comes solely from the ticket verified for this connection —
    // never from wire-supplied `from`/`name` (both are client-controlled).
    const msg = sanitizeChat(raw, this.names.get(fromConn.peer));
    for (const c of this.dataConns) {
      if (c !== fromConn && c.open) c.send(JSON.stringify(msg));
    }
    this.opts.onChat?.(msg);
  }

  /** Broadcast a chat line from the host to every connected viewer. */
  sendChat(text: string) {
    const msg = packChat(
      this.opts.hostName || "Host",
      text.slice(0, CHAT_MAX_LENGTH),
    );
    if (!msg.text.trim()) return;
    for (const c of this.dataConns) {
      if (c.open) c.send(JSON.stringify(msg));
    }
    this.opts.onChat?.(msg);
  }

  private startSampling() {
    this.timer = window.setInterval(() => void this.sample(), 2000);
  }

  private async sample() {
    const track = this.opts.stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    let totalBytes = 0;
    let ts = Date.now();
    for (const call of this.calls) {
      const pc = (call as unknown as { peerConnection?: RTCPeerConnection })
        .peerConnection;
      if (!pc) continue;
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === "outbound-rtp" && !r.isRemote) {
            totalBytes += r.bytesSent ?? 0;
            ts = r.timestamp ?? ts;
          }
        });
      } catch {
        /* ignore */
      }
    }
    const prev = this.baselines.get("agg");
    let kbps: number | null = null;
    if (prev) {
      const dt = (ts - prev.ts) / 1000;
      if (dt > 0)
        kbps = Math.round(((totalBytes - prev.bytes) * 8) / dt / 1000);
    }
    this.baselines.set("agg", { bytes: totalBytes, ts });
    this.opts.onStats({
      viewers: this.calls.size,
      bitrateKbps: this.calls.size ? (kbps ?? 0) : null,
      fps: settings?.frameRate ? Math.round(settings.frameRate) : null,
      width: settings?.width ?? null,
      height: settings?.height ?? null,
      totalConnections: this.totalConnections,
    });
  }

  stop() {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    for (const call of this.calls) call.close();
    this.calls.clear();
    for (const conn of this.dataConns) conn.close();
    this.dataConns.clear();
    this.peer.destroy();
  }
}
