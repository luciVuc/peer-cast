import Peer, { type DataConnection, type MediaConnection } from "peerjs";
import {
  CHAT_MAX_LENGTH,
  type RuntimeConfig,
  type BitrateConfig,
} from "@peer-cast/shared";

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
  /** Peer ID of the sender
   *  Only populated on the broadcaster side for mute/kick UI.
   *  Never included in wire messages. */
  senderPeerId?: string;
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
function dummyStream(): { stream: MediaStream; dispose: () => void } {
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
  //
  // The AudioContext is retained so `dispose` can close it. PeerJS does not
  // stop local tracks when a call closes, and the viewer auto-reconnects with
  // backoff, so without this every reconnect leaks a live audio thread, an
  // oscillator, and a canvas track — unbounded growth over a long session.
  let actx: AudioContext | null = null;
  try {
    const opts: AudioContextOptions = {};
    // AudioContext.setSinkId / sinkId option is Chrome 110+
    // type-cast because the TS lib may not have it yet.
    if ("setSinkId" in AudioContext.prototype) {
      (opts as Record<string, unknown>).sinkId = { type: "none" };
    }
    actx = new AudioContext(opts);
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

  return {
    stream: video,
    dispose: () => {
      for (const t of video.getTracks()) {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      }
      // Release the audio hardware thread; without this the context keeps
      // running (muted, via the virtual sink) for the life of the page.
      if (actx && actx.state !== "closed") void actx.close().catch(() => {});
    },
  };
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
  // The placeholder stream this viewer dials with (see dummyStream). Released
  // on close so reconnects don't accumulate audio contexts.
  let dummy: { stream: MediaStream; dispose: () => void } | null = null;

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
      dummy?.dispose();
      dummy = null;
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
    dummy = dummyStream();
    call = peer.call(targetPeerId, dummy.stream, {
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

// ─── Bitrate shaping (per-viewer maxBitrate) ────────────────────────────
//
// PeerCast has no SFU: every viewer gets its own RTCPeerConnection and its own
// encoder, so host egress is O(viewers). These helpers bound it.
//
// Simplicast/SVC is deliberately NOT used here. PeerJS builds its SDP with
// `addTrack()`, not `addTransceiver({sendEncodings})`, so rids cannot be put in
// the initial offer, and assigning `rid` via setParameters afterwards is ignored
// by Chrome. Desktop capture is also a poor simulcast source — the bitrate
// profile of scrolling text or a video window has nothing in common with a
// webcam. Resolution adaptation is delegated to the encoder via
// `degradationPreference` instead, which needs no SDP changes at all.

/** PeerJS exposes the underlying RTCPeerConnection on the connection object;
 *  this narrows the cast already used by replaceVideoTrack/sample(). */
type WithPeerConnection = { peerConnection?: RTCPeerConnection };

/**
 * Tier index for a viewer, given how many are already connected.
 *
 * The ladder does not run out: viewers past the last rung stay on the bottom
 * rung rather than being refused. Admission control and bandwidth shaping are
 * separate concerns — this one bounds bytes, not headcount — and someone is
 * perfectly happy watching a low-bitrate screen share. Refusing them to protect
 * everyone else's resolution would be the wrong trade.
 *
 * Exported for unit testing; it is pure and has no WebRTC dependency.
 */
export function tierForViewer(
  connectedCount: number,
  tiersKbps: number[],
): number {
  if (tiersKbps.length === 0) return 0;
  return Math.min(Math.max(0, connectedCount), tiersKbps.length - 1);
}

/** kbps cap for a tier index. Index 0 is the top of the ladder and is
 *  deliberately uncapped — the first viewers get the host's natural quality,
 *  which is what an operator with budget to spare expects. */
export function capForTier(tier: number, tiersKbps: number[]): number | null {
  if (tier <= 0) return null;
  return tiersKbps[Math.min(tier, tiersKbps.length - 1)] ?? null;
}

/**
 * Budget actually in force: the lesser of the operator's configured ceiling and
 * the browser's own estimate of available outgoing bandwidth.
 *
 * `availableOutgoingBitrate` is advisory. Chrome reports it, but it is absent on
 * browsers that do not compute it and can spike optimistically on a link about
 * to collapse. So it only ever *tightens* the budget — never widens it past
 * what the operator configured — and a missing or nonsensical value falls back
 * to the configured budget. Exported for unit testing.
 */
export function effectiveBudgetKbps(
  configuredKbps: number,
  measuredKbps: number | null,
  safetyFactor: number,
): number {
  if (
    measuredKbps == null ||
    !Number.isFinite(measuredKbps) ||
    measuredKbps <= 0
  )
    return configuredKbps;
  return Math.min(configuredKbps, Math.round(measuredKbps * safetyFactor));
}

/** Screen share is legibility-first: when bandwidth is short, drop resolution
 *  and hold the frame rate. Text stays readable, which is what viewers of a
 *  screen share actually care about. */
const DEGRADATION_PREFERENCE = "maintain-framerate" as const;

/** Serialize per-peer. `setParameters` throws if the connection is mid-
 *  negotiation, and `handleCall` fires for every viewer concurrently — an
 *  unserialized Promise.all over senders is the most likely source of flaky
 *  "connection failed" reports, so each peer keeps its own tail chain. */
const paramQueues = new WeakMap<RTCPeerConnection, Promise<void>>();

function serializeOn<T>(
  pc: RTCPeerConnection,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = paramQueues.get(pc) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  paramQueues.set(
    pc,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Apply `degradationPreference` to every sender on a connection.
 *
 *  This is a *hint* the encoder consults continuously, so unlike maxBitrate it
 *  has no single correct moment to be set. Applying it late is still
 *  beneficial, which is why it runs on the renegotiation re-assert path too. */
async function applyDegradation(pc: RTCPeerConnection): Promise<void> {
  await serializeOn(pc, async () => {
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      try {
        const params = sender.getParameters();
        if (!params.degradationPreference) {
          params.degradationPreference = DEGRADATION_PREFERENCE;
          await sender.setParameters(params);
        }
      } catch {
        /* NotSupportedError / mid-negotiation: the hint is optional and the
         * maxBitrate cap is the control that actually bounds egress. */
      }
    }
  });
}

/**
 * Cap every sender on `pc` at `maxKbps` (video and audio alike).
 *
 *  `maxBitrate` is a constraint, not a request: the encoder is free to stay
 *  below it, and will do so whenever it cannot fill it. That is exactly what we
 *  want — a static screen costs far less than its cap, and should not be padded
 *  out to waste a budget slot.
 */
async function applyBitrate(
  pc: RTCPeerConnection,
  maxKbps: number | null,
): Promise<void> {
  await serializeOn(pc, async () => {
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      try {
        const params = sender.getParameters();
        // `undefined` must be cleared explicitly — a sender retains its prior
        // cap for the life of the connection otherwise.
        if (maxKbps == null) {
          if (params.encodings?.[0]?.maxBitrate == null) continue;
          params.encodings = (params.encodings ?? []).map((e) => ({
            ...e,
            maxBitrate: undefined,
          }));
        } else {
          params.encodings = (params.encodings ?? [{}]).map((e) => ({
            ...e,
            maxBitrate: Math.round(maxKbps * 1000),
          }));
        }
        await sender.setParameters(params);
      } catch {
        /* setParameters rejects during negotiation and on senders the browser
         * will not let us reconfigure (e.g. a closed connection). The next
         * re-assert retries; failing here must never tear down a viewer. */
      }
    }
  });
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
  /**
   * Browser-measured headroom for outgoing traffic, in kbps. This is a live
   * estimate, not a configured value — it is absent/zero on browsers that do
   * not report `availableOutgoingBitrate`, which is why the shaping policy
   * treats it as advisory and never as a replacement for the operator budget.
   */
  availableOutgoingKbps: number | null;
  /** The budget actually in force for this broadcast, in kbps. */
  budgetKbps: number | null;
  /** Deepest tier index currently handed out; 0 = best tier. */
  tierIndex: number | null;
  /** Consecutive over-budget samples so far, for diagnosing the ratchet. */
  overBudgetSamples: number;
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
  /** Peer IDs muted by the broadcaster (messages dropped, not kicked). */
  private mutedPeers = new Set<string>();

  /**
   * Shaping policy from RuntimeConfig, or null when the operator configured
   * none — the unshaped mesh, where every sender stays uncapped.
   */
  private policy: BitrateConfig | null;
  /** Current tier index per viewer peer id, assigned at admission time.
   *  Never re-ranked upward; the ratchet only ever moves viewers deeper. */
  private tiers = new Map<string, number>();
  /** Consecutive over-budget samples. Reset the moment we are back inside. */
  private overBudgetSamples = 0;
  /** Effective budget for this broadcast, refreshed each sample. */
  private activeBudgetKbps: number | null = null;
  /** Guards the ratchet against re-walking the viewer set on every sample
   *  while over budget. Cleared once the batch settles. */
  private ratcheting = false;

  /**
   * Bounded chat history retained by the host.
   *
   * The host is the relay and therefore the authority on chat, but BroadcastPage
   * keeps a component-local copy in useState. Navigating away from /broadcast
   * is deliberate (the broadcast survives it), so on return that copy was empty
   * and the moderation controls — which render per message — were unreachable
   * until somebody posted again. Retaining a short history lets the page
   * rehydrate instead of silently losing the transcript.
   */
  private chatHistory: ChatMessage[] = [];

  constructor(opts: BroadcastHostOptions) {
    this.opts = opts;
    this.policy = opts.cfg.bitrate ?? null;
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
    // Assign the admission tier BEFORE answering so the very first frames this
    // viewer receives are already shaped. Assigning after would send a brief
    // burst of full-bitrate frames to every new viewer — exactly the spike the
    // policy exists to prevent, and it lands at the worst moment, when the
    // audience is already growing.
    const tier = this.admitTier();
    if (call.peer && tier != null) this.tiers.set(call.peer, tier);
    call.answer(this.opts.stream);
    this.calls.add(call);
    this.totalConnections++;
    const pc = (call as unknown as WithPeerConnection).peerConnection;
    if (pc) {
      void applyDegradation(pc).catch(() => {});
      const cap = this.capFor(tier);
      if (cap != null) void applyBitrate(pc, cap).catch(() => {});
    }
    // Evict on close as well as on the data-connection side. A media call and
    // its data connection share a peer id, but either can close independently:
    // a viewer whose DataConnection never opens (or whose tab dies abruptly, so
    // no `close` event fires at all) would otherwise leave a permanent entry.
    // PeerJS mints a fresh random id per reconnect, so every backoff retry
    // deposited another key — and `names` is what feeds connectedViewers(),
    // which would then report viewers who left hours ago.
    call.on("close", () => {
      this.calls.delete(call);
      if (call.peer) {
        this.names.delete(call.peer);
        this.tiers.delete(call.peer);
      }
    });
    call.on("error", () => {
      this.calls.delete(call);
      if (call.peer) {
        this.names.delete(call.peer);
        this.tiers.delete(call.peer);
      }
    });
    if (this.timer == null) this.startSampling();
  }

  /**
   * Pick a tier for a newly admitted viewer.
   *
   *  Tier is a function of how many viewers are already connected, capped at
   *  the bottom of the ladder. The ladder deliberately does not run out: a
   *  hundredth viewer gets the last rung's cap rather than being refused.
   *  Refusing is NOT an option here — admission control and bandwidth shaping
   *  are separate levers, and this one is bandwidth only. Rejecting viewers to
   *  protect per-viewer quality would mean dropping people who are perfectly
   *  happy watching a 300 kbps screen share.
   *
   *  Returns null when no policy is configured.
   */
  private admitTier(): number | null {
    if (!this.policy) return null;
    return tierForViewer(this.calls.size, this.policy.tiersKbps);
  }

  /** kbps cap for a tier index, or null for "uncapped" (tier 0 / no policy). */
  private capFor(tier: number | null): number | null {
    if (!this.policy || tier == null) return null;
    return capForTier(tier, this.policy.tiersKbps);
  }

  private effectiveBudget(measuredKbps: number | null): number | null {
    if (!this.policy) return null;
    return effectiveBudgetKbps(
      this.policy.budgetKbps,
      measuredKbps,
      this.policy.safetyFactor,
    );
  }

  /**
   * Move every connected viewer one rung deeper. Sustained overload only —
   * see the over-budget counter in sample(). One-way: a viewer that has been
   * demoted is never promoted back, so quality decays monotonically under load
   * instead of oscillating.
   */
  private ratchetDown(): void {
    if (!this.policy || this.ratcheting) return;
    const last = this.policy.tiersKbps.length - 1;
    const work: Array<Promise<void>> = [];
    for (const call of this.calls) {
      const id = call.peer;
      if (!id) continue;
      const current = this.tiers.get(id) ?? 0;
      if (current >= last) continue; // already at the bottom rung
      const next = current + 1;
      this.tiers.set(id, next);
      const pc = (call as unknown as WithPeerConnection).peerConnection;
      const cap = this.capFor(next);
      if (pc && cap != null) work.push(applyBitrate(pc, cap).catch(() => {}));
    }
    if (work.length === 0) return;
    this.ratcheting = true;
    void Promise.all(work).finally(() => {
      this.ratcheting = false;
    });
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
    // Drop messages from muted peers silently.
    if (this.mutedPeers.has(fromConn.peer)) return;
    // Attribution comes solely from the ticket verified for this connection —
    // never from wire-supplied `from`/`name` (both are client-controlled).
    const msg = sanitizeChat(raw, this.names.get(fromConn.peer));
    // Attach sender peer ID so the host UI can show mute/kick controls.
    // This field is stripped before relaying to other viewers.
    const msgWithPeer: ChatMessage = { ...msg, senderPeerId: fromConn.peer };
    for (const c of this.dataConns) {
      if (c !== fromConn && c.open) {
        const { senderPeerId: _drop, ...wireMsg } = msgWithPeer;
        c.send(JSON.stringify(wireMsg));
      }
    }
    this.chatHistory = [...this.chatHistory.slice(-199), msgWithPeer];
    this.opts.onChat?.(msgWithPeer);
  }

  /**
   * Mute a viewer by peer id: their chat messages are silently dropped.
   * The viewer can still watch — only their chat is suppressed.
   */
  mutePeer(peerId: string): void {
    this.mutedPeers.add(peerId);
  }

  /** Un-mute a previously muted viewer. */
  unmutePeer(peerId: string): void {
    this.mutedPeers.delete(peerId);
  }

  isMuted(peerId: string): boolean {
    return this.mutedPeers.has(peerId);
  }

  /**
   * Kick a viewer by peer id: close their media + data connections.
   * They will reconnect via the viewer page's automatic reconnect, but their
   * ticket is consumed so a re-resolve is required — giving the broadcaster
   * a window before they reconnect.
   */
  kickPeer(peerId: string): void {
    for (const call of this.calls) {
      if (call.peer === peerId) {
        call.close();
        this.calls.delete(call);
      }
    }
    for (const conn of this.dataConns) {
      if (conn.peer === peerId) {
        conn.close();
        this.dataConns.delete(conn);
      }
    }
    this.names.delete(peerId);
    this.mutedPeers.delete(peerId);
    this.tiers.delete(peerId);
  }

  /** Snapshot of retained chat, for rehydrating a remounted host page. */
  chatLog(): ChatMessage[] {
    return this.chatHistory;
  }

  /** Peer IDs currently muted, for rehydrating a remounted host page. */
  listMuted(): string[] {
    return [...this.mutedPeers];
  }

  /** List all currently connected viewer peer IDs with their display names. */
  connectedViewers(): Array<{ peerId: string; name: string }> {
    return [...this.names.entries()].map(([peerId, name]) => ({
      peerId,
      name,
    }));
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

  /** Replace the outgoing camera track without renegotiating viewer calls. */
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    const senders = [...this.calls]
      .map(
        (call) =>
          (call as unknown as { peerConnection?: RTCPeerConnection })
            .peerConnection,
      )
      .flatMap((pc) =>
        pc
          ? pc.getSenders().filter((sender) => sender.track?.kind === "video")
          : [],
      );

    try {
      await Promise.all(senders.map((sender) => sender.replaceTrack(track)));
    } catch (err) {
      track.stop();
      throw err;
    }

    // replaceTrack preserves encodings, but the cap is not guaranteed to have
    // survived — a sender created fresh by a renegotiation starts uncapped.
    // Re-assert every viewer's own tier rather than assuming, so swapping the
    // captured surface can never quietly remove the shaping policy.
    if (this.policy) {
      const perPeer = [...this.calls].flatMap((call) => {
        const pc = (call as unknown as WithPeerConnection).peerConnection;
        if (!pc || !call.peer) return [];
        const cap = this.capFor(this.tiers.get(call.peer) ?? 0);
        return [applyBitrate(pc, cap).catch(() => {})];
      });
      await Promise.all(perPeer);
    }

    const oldTracks = this.opts.stream.getVideoTracks();
    oldTracks.forEach((oldTrack) => this.opts.stream.removeTrack(oldTrack));
    this.opts.stream.addTrack(track);
    oldTracks.forEach((oldTrack) => oldTrack.stop());
  }

  private async sample() {
    const track = this.opts.stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    let totalBytes = 0;
    let ts = Date.now();
    let availableOutgoing = 0;
    for (const call of this.calls) {
      const pc = (call as unknown as WithPeerConnection).peerConnection;
      if (!pc) continue;
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === "outbound-rtp" && !r.isRemote) {
            totalBytes += r.bytesSent ?? 0;
            ts = r.timestamp ?? ts;
          }
          // `availableOutgoingBitrate` is the browser's own headroom estimate
          // for this pair. It is absent on browsers that do not compute it, so
          // it is summed defensively and treated as advisory — never required.
          if (
            r.type === "candidate-pair" &&
            typeof r.availableOutgoingBitrate === "number" &&
            r.availableOutgoingBitrate > 0
          ) {
            availableOutgoing = Math.max(
              availableOutgoing,
              r.availableOutgoingBitrate,
            );
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

    const measuredKbps =
      availableOutgoing > 0 ? availableOutgoing / 1000 : null;
    this.activeBudgetKbps = this.effectiveBudget(measuredKbps);

    // Sustained-overload ratchet. `kbps` is null on the first sample (no
    // baseline yet) and while nobody is connected; neither is over budget, so
    // the counter resets rather than accumulating toward a spurious demotion.
    const overBudget =
      this.policy != null &&
      kbps != null &&
      this.activeBudgetKbps != null &&
      kbps > this.activeBudgetKbps;
    this.overBudgetSamples = overBudget ? this.overBudgetSamples + 1 : 0;
    if (
      overBudget &&
      this.overBudgetSamples >= (this.policy?.ratchetSamples ?? 3) &&
      !this.ratcheting
    ) {
      this.ratchetDown();
      // Reset so the next demotion needs a fresh run of sustained overload,
      // rather than cascading one tier per sample while still over budget.
      this.overBudgetSamples = 0;
    }

    const tierValues = [...this.tiers.values()];
    this.opts.onStats({
      viewers: this.calls.size,
      bitrateKbps: this.calls.size ? (kbps ?? 0) : null,
      fps: settings?.frameRate ? Math.round(settings.frameRate) : null,
      width: settings?.width ?? null,
      height: settings?.height ?? null,
      totalConnections: this.totalConnections,
      availableOutgoingKbps: measuredKbps ? Math.round(measuredKbps) : null,
      budgetKbps: this.activeBudgetKbps,
      tierIndex: this.policy
        ? tierValues.length
          ? Math.max(...tierValues)
          : 0
        : null,
      overBudgetSamples: this.overBudgetSamples,
    });
  }

  stop() {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    for (const call of this.calls) call.close();
    this.calls.clear();
    for (const conn of this.dataConns) conn.close();
    this.dataConns.clear();
    this.tiers.clear();
    this.names.clear();
    this.overBudgetSamples = 0;
    this.activeBudgetKbps = null;
    this.peer.destroy();
  }
}
