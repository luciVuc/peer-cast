/**
 * PeerCast offscreen document — the broadcast host.
 *
 * Responsibilities:
 *  1. Consume the MediaStreamId produced by the popup (under user gesture)
 *     and turn it back into a real tab/desktop MediaStream via getUserMedia.
 *  2. Host a PeerJS peer that answers every incoming call with that stream,
 *     so multiple viewers can watch simultaneously — optionally gated on an
 *     access code carried in each call's metadata.
 *  3. Publish session state (status, PeerID, viewers, errors, outgoing
 *     bitrate) by relaying patches to the service worker, which persists
 *     them to storage where the popup picks them up live.
 *
 * This document persists independently of the popup, which is what keeps the
 * capture and all WebRTC connections alive after the popup closes.
 */

/** Key under chrome.storage.local where session state lives. */
const STATE_KEY = "session";

/** How long to wait for the signaling server before giving up (ms). */
const SIGNALING_TIMEOUT_MS = 20000;

// How many times to attempt claiming a requested channel ID before giving
// up (our own just-ended session may still be registered server-side).
const CHANNEL_CLAIM_ATTEMPTS = 3;

/** Interval between outgoing-bitrate samples (ms). */
const BITRATE_SAMPLE_MS = 2000;

/** @type {Peer|null} The hosting peer. */
let peer = null;
/** @type {MediaStream|null} The captured tab/desktop stream. */
let stream = null;
/** @type {AudioContext|null} Local playback so the presenter still hears the tab. */
let audioContext = null;
/** @type {Set<MediaConnection>} Live incoming calls. */
const calls = new Set();

/** Optional manual access code viewers must echo to be answered. */
let accessKey = null;
/** "public" | "authenticated" | "code" — backend access policy for this stream. */
let accessPolicy = "public";
/** Backend base URL, passed from background via START (for ticket verification). */
let serverUrl = null;
/** Viewers rejected this session (bad token or failed ticket). */
let declinedViewers = 0;
/** Cumulative accepted viewer connections this session. */
let totalConnections = 0;
/** @type {number|null} Interval handle for the bitrate sampler. */
let bitrateTimer = null;
/** Per-connection cumulative byte-sent baselines for the bitrate sampler. */
let bitrateBaselines = new Map();

/** Verbose diagnostics switch (delivered via the START message). */
let dbgOn = false;
/**
 * Conditional diagnostic logging.
 * @param {...unknown} args
 */
function dbg(...args) {
  if (dbgOn) console.log("[PeerCast]", ...args);
}

/**
 * Merge a partial patch into the persisted session state.
 *
 * Offscreen documents cannot rely on direct chrome.storage access across
 * Chromium builds, so the service worker — which owns persisted state —
 * applies patches relayed over the extension message bus.
 * @param {Partial<object>} patch
 */
async function setState(patch) {
  try {
    await chrome.runtime.sendMessage({
      target: "background",
      type: "STATE_PATCH",
      patch,
    });
  } catch {
    /* worker unreachable; state stays as-is until the next update */
  }
}

/**
 * Translate a PeerJS error into presenter-friendly text.
 * @param {Error & {type?: string}} err
 * @returns {string}
 */
function describePeerError(err) {
  switch (err?.type) {
    case "browser-incompatible":
      return "This browser does not support the WebRTC features PeerCast needs.";
    case "network":
      return "Lost contact with the signaling network. Check your connection.";
    case "server-error":
      return "The signaling server could not be reached. Check the server's connection and try again in a moment.";
    case "socket-error":
      return "The connection to the signaling server dropped unexpectedly.";
    case "unavailable-id":
      return "That channel ID is taken right now. Try again in a few seconds or pick another.";
    case "webrtc":
      return "The browser reported a WebRTC failure while connecting.";
    default:
      return err?.message || "An unknown broadcast error occurred.";
  }
}

/**
 * Validate a requested channel ID against PeerJS's own ID rules
 * (alphanumeric, with single spaces/underscores/hyphens as separators).
 * @param {unknown} raw
 * @returns {string|undefined} The usable ID, or undefined for a random one.
 */
function normalizeChannelId(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id || id.length > 100) return undefined;
  return /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.test(id) ? id : undefined;
}

/**
 * Tear down every local resource (peer, tracks, audio graph, monitors).
 * Safe to call more than once.
 */
async function teardownLocal() {
  stopBitrateMonitor();
  accessPolicy = "public";
  serverUrl = null;
  for (const call of calls) {
    try {
      call.close();
    } catch {
      /* already gone */
    }
  }
  calls.clear();
  if (peer) {
    try {
      peer.destroy();
    } catch {
      /* already destroyed */
    }
    peer = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (audioContext) {
    try {
      await audioContext.close();
    } catch {
      /* already closed */
    }
    audioContext = null;
  }
}

/**
 * Resolve once the peer has registered with the signaling server, or reject.
 * @param {number} timeoutMs
 * @returns {Promise<string>} The assigned Peer ID.
 */
function waitForOpen(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Timed out reaching the signaling server. Check your internet connection.",
          ),
        ),
      timeoutMs,
    );
    const onOpen = (id) => {
      clearTimeout(timer);
      resolve(id);
    };
    const onError = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    peer.once("open", onOpen);
    peer.once("error", onError);
  });
}

/**
 * Count currently connected viewers and persist it.
 */
function reportViewerCount() {
  let watching = 0;
  for (const call of calls) {
    const state = call.peerConnection?.connectionState;
    if (!state || state === "connected" || state === "completed") watching++;
  }
  setState({ viewers: watching, totalConnections });
}

/**
 * Sample every live RTCPeerConnection's outbound-rtp counters and persist
 * the aggregate outgoing bitrate so the popup can show a live readout.
 */
async function sampleBitrate() {
  // outbound-rtp.bytesSent is cumulative per connection; keep per-connection
  // totals across samples and persist the delta as kbps.
  const last = bitrateBaselines;
  let totalDelta = 0;
  let anySampled = false;
  for (const call of calls) {
    const pc = call.peerConnection;
    if (!pc) continue;
    try {
      const stats = await pc.getStats();
      let cumulative = 0;
      stats.forEach((r) => {
        if (r.type === "outbound-rtp" && typeof r.bytesSent === "number")
          cumulative += r.bytesSent;
      });
      // First sighting of a connection seeds its baseline (no delta yet).
      const prev = last.has(pc)
        ? /** @type {number} */ (last.get(pc))
        : cumulative;
      if (cumulative >= prev) totalDelta += cumulative - prev;
      last.set(pc, cumulative);
      anySampled = true;
    } catch {
      /* pc closing mid-sample; skip */
    }
  }
  // Drop baselines for connections that are gone.
  for (const pc of [...last.keys()]) {
    if (![...calls].some((c) => c.peerConnection === pc)) last.delete(pc);
  }
  if (!anySampled) {
    setState({ bitrateKbps: calls.size ? 0 : null });
    return;
  }
  const kbps = Math.round((totalDelta * 8) / (BITRATE_SAMPLE_MS / 1000) / 1000);
  setState({ bitrateKbps: Number.isFinite(kbps) ? kbps : null });
}

/** Start the periodic outgoing-bitrate sampler. */
function startBitrateMonitor() {
  stopBitrateMonitor();
  bitrateBaselines = new Map(); // fresh slate on each session
  setState({ bitrateKbps: 0 });
  bitrateTimer = setInterval(sampleBitrate, BITRATE_SAMPLE_MS);
}

/** Stop and clear the bitrate sampler. */
function stopBitrateMonitor() {
  if (bitrateTimer) clearInterval(bitrateTimer);
  bitrateTimer = null;
}

/**
 * Answer an incoming viewer call with the captured stream, after checking
 * the optional access code carried in the call metadata.
 * @param {MediaConnection} call
 */
async function answerCall(call) {
  if (!stream) {
    dbg("call from", call.peer, "ignored — no stream");
    return;
  }
  if (accessKey && call.metadata?.token !== accessKey) {
    declinedViewers++;
    dbg("declining call from", call.peer, "(bad/missing access code)");
    setState({
      lastWarning:
        "Declined a viewer without the correct access code" +
        (declinedViewers > 1 ? ` (${declinedViewers} so far).` : "."),
    });
    // Closing pre-answer leaves PeerJS on the viewer side in limbo: it can
    // emit remnant stream events that look like real media, sending gated
    // viewers into an endless reconnect loop. Tell them explicitly over a
    // tiny data connection so they can surface the refusal instead.
    try {
      const rej = peer.connect(call.peer, {
        metadata: { rejection: "bad-token" },
      });
      setTimeout(() => {
        try {
          rej.close();
        } catch {
          /* already gone */
        }
      }, 5000);
    } catch (err) {
      dbg("rejection signal failed:", err?.message || err);
    }
    try {
      call.close();
    } catch {
      /* already gone */
    }
    return;
  }
  dbg("answering call from", call.peer);
  calls.add(call);
  totalConnections++;
  // `stream` may be replaced by null during teardown; bind what we have now.
  call.answer(stream);

  // Wire event handlers immediately (before any async work) so we never miss
  // close/error/state-change events while the proof round-trip is in flight.
  call.on("close", () => {
    dbg("call closed by", call.peer);
    calls.delete(call);
    reportViewerCount();
  });
  call.on("error", (err) => {
    dbg("call error from", call.peer, err?.type || "", err?.message || "");
    calls.delete(call);
    reportViewerCount();
  });
  // Track the underlying RTCPeerConnection for accurate live counts.
  call.peerConnection?.addEventListener("connectionstatechange", () => {
    const state = call.peerConnection?.connectionState;
    dbg("pc state", call.peer, state);
    if (state === "failed" || state === "closed") {
      calls.delete(call);
    }
    reportViewerCount();
  });

  // For non-public broadcasts, verify the viewer's backend-issued ticket. This is
  // an independent host-side check: even if a viewer obtained the peer id
  // out-of-band, they still cannot join without a valid ticket.
  if (accessPolicy !== "public" && serverUrl) {
    const ticket = call.metadata?.ticket;
    let allowed = false;
    try {
      const res = await PeerCastApi.verifyTicket(serverUrl, ticket, peer.id);
      allowed = !!res?.ok;
    } catch (err) {
      dbg("ticket verification failed:", err?.message || err);
    }
    if (!allowed) {
      declinedViewers++;
      dbg("declining call from", call.peer, "(no valid access ticket)");
      setState({
        lastWarning:
          "Declined a viewer without a valid access ticket" +
          (declinedViewers > 1 ? ` (${declinedViewers} so far).` : "."),
      });
      try {
        const rej = peer.connect(call.peer, {
          metadata: { rejection: "authentication-required" },
        });
        setTimeout(() => {
          try {
            rej.close();
          } catch {
            /* already gone */
          }
        }, 5000);
      } catch (err) {
        dbg("rejection signal failed:", err?.message || err);
      }
      try {
        call.close();
      } catch {
        /* already gone */
      }
      return;
    }
  }
}

/**
 * Handle external capture loss (e.g. the captured tab was closed).
 */
async function handleCaptureEnded() {
  if (!stream && !peer) return; // already torn down
  await teardownLocal();
  await setState({
    status: "idle",
    peerId: null,
    startedAt: null,
    viewers: 0,
    bitrateKbps: null,
    endedReason: "Capture ended — the shared source was closed.",
  });
}

/**
 * Audio re-route + signaling host — everything after a successful capture.
 * @param {MediaStream} capturedStream
 * @param {object|undefined} signalConfig
 * @param {string|undefined} requestedId Persistent channel ID, if any.
 * @param {Array|undefined} iceServers Custom ICE servers (replaces defaults).
 */
async function hostBroadcast(
  capturedStream,
  signalConfig,
  requestedId,
  iceServers,
) {
  // Re-play captured audio locally so the presenter still hears their tab
  // (capture redirects tab audio into the stream).
  try {
    audioContext = new AudioContext();
    audioContext
      .createMediaStreamSource(capturedStream)
      .connect(audioContext.destination);
  } catch {
    /* Non-fatal: presenter just won't hear the tab locally. */
  }

  // Surface external track endings instead of hanging silently.
  capturedStream.getTracks().forEach((t) =>
    t.addEventListener("ended", () => {
      handleCaptureEnded();
    }),
  );

  await setState({ status: "starting", error: null });

  // Register with the signaling server and wait for our Peer ID. A requested
  // channel ID can collide with our own just-ended session that the server
  // has not reaped yet, so retry the claim a few times before erroring.
  for (let attempt = 1; ; attempt++) {
    // A user-supplied ICE list replaces PeerJS's defaults wholesale; when
    // absent we pass nothing so PeerJS keeps its own STUN/TURN defaults.
    const peerOptions = { ...signalConfig };
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      peerOptions.config = { ...peerOptions.config, iceServers };
    }
    peer = new Peer(requestedId || undefined, peerOptions);
    peer.on("call", answerCall);
    peer.on("disconnected", () => {
      // Signaling lost; established media flows continue. Try to re-register.
      try {
        peer.reconnect();
      } catch {
        /* peer already destroyed */
      }
    });
    peer.on("error", (err) => {
      // Pre-open failures are decided by the claim loop below (waitForOpen
      // rejects on them). Errors after 'open' usually concern one call —
      // keep broadcasting but surface them.
      if (peer?.open) setState({ lastWarning: describePeerError(err) });
    });

    let id;
    try {
      id = await waitForOpen(SIGNALING_TIMEOUT_MS);
    } catch (err) {
      const busy =
        !!requestedId &&
        /** @type {Error & {type?: string}} */ (err)?.type === "unavailable-id";
      if (busy && attempt < CHANNEL_CLAIM_ATTEMPTS) {
        dbg("channel id busy; retrying claim", attempt + 1);
        await teardownLocal();
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
      throw err;
    }

    dbg("signaling open, assigned id:", id);
    startBitrateMonitor();
    await setState({
      status: "live",
      peerId: id,
      startedAt: Date.now(),
      viewers: 0,
      error: null,
      endedReason: null,
    });
    // Announce the live session to the registry so viewers can find this
    // broadcaster by @username. Non-fatal — the broadcast runs regardless.
    chrome.runtime
      .sendMessage({
        target: "background",
        type: "ANNOUNCE_SESSION",
        peerId: id,
        access: accessPolicy,
      })
      .catch(() => {});
    return;
  }
}

/**
 * Ask the service worker for a fresh capture token for an already-granted
 * tab. Tokens are single-use and a failed getUserMedia attempt may consume
 * one, so retries need a new id. Only valid for tab sources.
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function refreshStreamId(tabId) {
  const res = await chrome.runtime.sendMessage({
    target: "background",
    type: "GET_STREAM_ID",
    tabId,
  });
  if (!res?.ok) throw new Error(res?.error || "no stream id");
  return res.streamId;
}

/**
 * Build the mandatory-constraint block for the configured source.
 * @param {string} sourceId Capture token.
 * @param {boolean} desktop True for a desktopCapture (screen/window) source.
 */
function sourceConstraints(sourceId, desktop) {
  return {
    chromeMediaSource: desktop ? "desktop" : "tab",
    chromeMediaSourceId: sourceId,
  };
}

/**
 * Apply persisted quality caps to video constraints.
 * @param {object|undefined} caps { maxFps?, maxHeight? }
 */
function cappedVideoConstraints(caps) {
  /** @type {Record<string, number>} */
  const v = {};
  // Reasonable ceiling keeps remote playback smooth on weak uplinks; the
  // Advanced controls may lower (or lift to 60) this default.
  v.maxFrameRate = caps?.maxFps > 0 ? Math.min(60, caps.maxFps) : 30;
  if (caps?.maxHeight > 0) v.maxHeight = caps.maxHeight;
  // maxWidth is intentionally omitted — it is never written by the UI
  // (only maxHeight from the resolution selector is exposed).
  return v;
}

/**
 * Consume the capture token, retrying on transient AbortErrors while the
 * previous capturer is still releasing (rapid restart case). Desktop tokens
 * cannot be re-minted, so they are retried as-is; tab tokens get fresh ones
 * from the service worker via exponential backoff (~7.5s total).
 *
 * For desktop sources system audio is best-effort: platforms without it
 * (Linux, macOS window mode…) reject audio-inclusive requests, so we fall
 * back to video-only instead of failing the whole broadcast.
 * @param {{streamId: string, tabId?: number, desktop?: boolean,
 *           hasSystemAudio?: boolean}} msg
 * @returns {Promise<MediaStream>}
 */
async function captureTabStream(msg) {
  const backoffs = [0, 500, 1000, 2000, 4000];
  const caps =
    /** @type {{maxFps?: number, maxHeight?: number}|undefined} */
    (msg.qualityCaps);

  if (!msg.desktop) {
    let streamId = msg.streamId;
    /** @type {unknown} */ let lastErr = null;
    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      if (backoffs[attempt])
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: sourceConstraints(streamId, false),
          },
          video: {
            mandatory: {
              ...sourceConstraints(streamId, false),
              ...cappedVideoConstraints(caps),
            },
          },
        });
      } catch (err) {
        lastErr = err;
        dbg(
          `capture attempt ${attempt + 1}/${backoffs.length} failed:`,
          err?.name,
          err?.message,
        );
        if (msg.tabId == null || err?.name !== "AbortError") break;
        try {
          streamId = await refreshStreamId(msg.tabId);
        } catch {
          break; // cannot re-mint; surface the original failure
        }
      }
    }
    throw /** @type {Error} */ (lastErr);
  }

  // --- desktop/window source -------------------------------------------------
  /** @type {unknown} */ let lastDesktopErr = null;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt])
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: sourceConstraints(msg.streamId, true),
        },
        video: {
          mandatory: {
            ...sourceConstraints(msg.streamId, true),
            ...cappedVideoConstraints(caps),
          },
        },
      });
    } catch (err) {
      lastDesktopErr = err;
      dbg(`desktop capture attempt ${attempt + 1} failed:`, err?.name);
      // Most likely no system-audio support on this platform/source —
      // degrade to video-only rather than giving up entirely.
      if (err?.name !== "AbortError" || msg.hasSystemAudio === false) break;
    }
  }
  // Video-only fallback (also covers the first-attempt hard failures).
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt])
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            ...sourceConstraints(msg.streamId, true),
            ...cappedVideoConstraints(caps),
          },
        },
      });
    } catch (err) {
      lastDesktopErr = err;
      dbg(
        `desktop video-only attempt ${attempt + 1} failed:`,
        err?.name,
        err?.message,
      );
    }
  }
  throw /** @type {Error} */ (lastDesktopErr);
}

/**
 * Human-readable description of what is being shared, for the popup's live
 * card. Desktop sources report their surface kind via the video track's
 * `displaySurface` setting ("monitor" | "window" | "browser"); the track
 * label usually carries the window title when one exists. Tab sources are
 * already identified by their page title/URL in the UI, so they need none.
 * @param {MediaStream} capturedStream
 * @param {boolean} desktop True for a desktopCapture source.
 * @returns {string|null}
 */
function describeSource(capturedStream, desktop) {
  if (!desktop) return null;
  const track = capturedStream.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  const label = (track?.label || "").trim();
  switch (settings.displaySurface) {
    case "monitor":
      return "Entire screen";
    case "window":
      return label && !/^screen/i.test(label)
        ? `Window — ${label}`
        : "App window";
    case "browser":
      return "Browser tab";
    default:
      // Older builds may omit displaySurface; fall back to reading the
      // label's shape ("Screen 2" ⇒ a monitor, anything else ⇒ a window).
      if (!label) return null;
      return /^screen/i.test(label) ? "Entire screen" : `Window — ${label}`;
  }
}

/**
 * Begin the broadcast: consume the streamId, host the peer, publish state.
 * Any unexpected failure lands in persisted state instead of hanging forever.
 * @param {{streamId: string, tabId?: number, desktop?: boolean,
 *           hasSystemAudio?: boolean, signalConfig?: object,
 *           channelId?: string, iceServers?: Array,
 *           qualityCaps?: object, accessKey?: string,
 *           tabTitle?: string, tabUrl?: string}} msg
 */
async function handleStart(msg) {
  dbgOn = !!msg.debug;
  dbg("START received; streamId len:", msg.streamId?.length);
  if (peer || stream) {
    await setState({
      status: "error",
      error: "A broadcast appears to be running already. Stop it first.",
    });
    return;
  }
  declinedViewers = 0;
  totalConnections = 0;
  // Access gate config arrives with the START message because offscreen
  // documents cannot reliably read chrome.storage themselves.
  accessKey =
    typeof msg.accessKey === "string" && msg.accessKey.trim()
      ? msg.accessKey.trim()
      : null;
  accessPolicy =
    msg.accessPolicy === "authenticated" || msg.accessPolicy === "code"
      ? msg.accessPolicy
      : "public";
  serverUrl =
    typeof msg.serverUrl === "string" && msg.serverUrl ? msg.serverUrl : null;

  // 1. Turn the gesture-bound stream ID back into a real MediaStream.
  try {
    stream = await captureTabStream(msg);
    dbg(
      "captured:",
      stream.getVideoTracks().length,
      "video /",
      stream.getAudioTracks().length,
      "audio tracks",
    );
    await setState({ sourceLabel: describeSource(stream, !!msg.desktop) });
  } catch (err) {
    // Surface the raw failure for diagnosability, then report upstream.
    console.warn("PeerCast: getUserMedia failed:", err?.name, err?.message);
    await setState({
      status: "error",
      error:
        "Could not attach to the shared source (" +
        (err?.name || "unknown error") +
        "). It may have been closed — try starting again.",
    });
    return;
  }

  try {
    await hostBroadcast(
      stream,
      msg.signalConfig,
      normalizeChannelId(msg.channelId),
      msg.iceServers,
    );
  } catch (err) {
    console.warn("PeerCast: broadcast failed:", err?.message || err);
    await teardownLocal();
    await setState({
      status: "error",
      error: err?.type
        ? describePeerError(/** @type {Error & {type?: string}} */ (err))
        : "Broadcast failed: " + String(err?.message || err),
    });
  }
}

/**
 * End the broadcast deliberately (popup Stop button / Cancel / hotkey).
 * @param {(result: {ok: boolean}) => void} sendResponse
 */
async function handleStop(sendResponse) {
  await teardownLocal();
  await setState({
    status: "idle",
    peerId: null,
    startedAt: null,
    viewers: 0,
    bitrateKbps: null,
    error: null,
    lastWarning: null,
    endedReason: null,
    sourceLabel: null,
  });
  sendResponse({ ok: true });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  if (msg.type === "START") {
    // Fire-and-forget: progress is published via storage, not the response.
    handleStart(msg);
    return false;
  }
  if (msg.type === "STOP") {
    // Respond only after full teardown so the caller knows when to close us.
    handleStop(sendResponse);
    return true; // keep the message channel open for the async response
  }
  return false;
});
