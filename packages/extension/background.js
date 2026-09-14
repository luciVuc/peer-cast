/**
 * PeerCast service worker — self-hosted backend edition.
 *
 * Identity + discovery are owned by the PeerCast backend (Express + SQLite).
 * A signed-in user broadcasts under their @username; every broadcast gets a fresh
 * random PeerJS peer id (assigned by the backend's own signaling server) so
 * nothing can be squatted. Backend calls are best-effort where possible, but
 * a broadcast cannot start unless the user is signed in.
 *
 * Responsibilities:
 *   1. Session state serialisation (single writer, serialised write chain).
 *   2. Keyboard-command entry points (tabCapture grant requires the command
 *      context; both start paths funnel through buildStartPayload here).
 *   3. Backend integration: create a broadcast on go-live, end it on go-offline,
 *      forward live stats.
 *   4. Auth-session management (JWT stored in chrome.storage.session).
 *   5. Desktop/window media picker.
 */

/* global PeerCastApi */
importScripts("lib/api-client.js");

const STATE_KEY = "session";

// ─── Install / startup ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ [STATE_KEY]: { status: "idle" } });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ [STATE_KEY]: { status: "idle" } });
});

// ─── Session state (single writer) ────────────────────────────────────────────

let sessionWriteChain = Promise.resolve();

function setSession(patch) {
  const run = sessionWriteChain.then(async () => {
    const stored = await chrome.storage.local.get(STATE_KEY);
    await chrome.storage.local.set({
      [STATE_KEY]: { ...(stored[STATE_KEY] || {}), ...patch },
    });
  });
  sessionWriteChain = run.catch(() => {});
  return run;
}

async function getSession() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] || {};
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function getServerUrl() {
  try {
    const { serverUrl } = await chrome.storage.local.get("serverUrl");
    if (!serverUrl || typeof serverUrl !== "string") return undefined;
    return serverUrl.trim().replace(/\/$/, "") || undefined;
  } catch {
    return undefined;
  }
}

async function getQualityCaps() {
  try {
    const { qualityCaps } = await chrome.storage.local.get("qualityCaps");
    if (!qualityCaps || typeof qualityCaps !== "object") return undefined;
    const caps = {};
    for (const k of ["maxFps", "maxHeight"]) {
      const n = Number(qualityCaps[k]);
      if (Number.isFinite(n) && n > 0) caps[k] = Math.round(n);
    }
    return Object.keys(caps).length > 0 ? caps : undefined;
  } catch {
    return undefined;
  }
}

// Pending broadcast metadata chosen in the popup, applied when the offscreen
// host announces its assigned peer id.
async function getPendingBroadcast() {
  const { pendingBroadcast } =
    await chrome.storage.local.get("pendingBroadcast");
  return pendingBroadcast || {};
}
async function setPendingBroadcast(meta) {
  await chrome.storage.local.set({ pendingBroadcast: meta });
}

// ─── Auth session (JWT) ─────────────────────────────────────────────────────

/** @returns {Promise<{token: string, username: string}|null>} */
async function getAuth() {
  try {
    const { auth } = await chrome.storage.session.get("auth");
    if (auth?.token && auth?.username) return auth;
    return null;
  } catch {
    return null;
  }
}
async function setAuth(auth) {
  await chrome.storage.session.set({ auth });
}
async function clearAuth() {
  await chrome.storage.session.remove("auth");
}
async function isSignedIn() {
  return !!(await getAuth());
}

// ─── Backend integration ─────────────────────────────────────────────────────

/** Create the live broadcast record; store its id for stats + end. */
async function backendStart(peerId) {
  const [serverUrl, auth, meta] = await Promise.all([
    getServerUrl(),
    getAuth(),
    getPendingBroadcast(),
  ]);
  if (!serverUrl || !auth?.token) return;
  try {
    const { broadcast } = await PeerCastApi.startBroadcast(
      serverUrl,
      auth.token,
      {
        title: meta.title || "Live broadcast",
        access: meta.access || "public",
        source: meta.source || "tab",
        peerId,
        accessCode: meta.access === "code" ? meta.accessCode : undefined,
      },
    );
    await setSession({ broadcastId: broadcast.id });
  } catch (err) {
    console.warn("PeerCast: backend start failed:", err?.message);
    await setSession({
      lastWarning:
        "Broadcast is live locally but the server didn't record it: " +
        (err?.message || "unknown error"),
    });
  }
}

async function backendEnd() {
  const [serverUrl, auth, session] = await Promise.all([
    getServerUrl(),
    getAuth(),
    getSession(),
  ]);
  if (!serverUrl || !auth?.token || !session.broadcastId) return;
  try {
    await PeerCastApi.endBroadcast(serverUrl, auth.token, session.broadcastId);
  } catch (err) {
    console.warn("PeerCast: backend end failed:", err?.message);
  }
}

// Throttled stats forwarding.
let lastStatsAt = 0;
async function forwardStats(patch) {
  const now = Date.now();
  if (now - lastStatsAt < 4000) return;
  const [serverUrl, auth, session] = await Promise.all([
    getServerUrl(),
    getAuth(),
    getSession(),
  ]);
  if (!serverUrl || !auth?.token || !session.broadcastId) return;
  lastStatsAt = now;
  try {
    await PeerCastApi.updateStats(serverUrl, auth.token, session.broadcastId, {
      viewers: patch.viewers ?? session.viewers ?? 0,
      bitrateKbps: patch.bitrateKbps ?? session.bitrateKbps ?? null,
      fps: null,
      width: null,
      height: null,
      totalConnections:
        patch.totalConnections ?? session.totalConnections ?? undefined,
    });
  } catch {
    /* best effort */
  }
}

// ─── Offscreen document lifecycle ─────────────────────────────────────────────

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification:
      "Hosts the tab-capture stream and the PeerJS WebRTC broadcast after the popup closes.",
  });
}

// ─── Start payload ────────────────────────────────────────────────────────────

async function buildStartPayload(streamId, meta) {
  const serverUrl = await getServerUrl();
  const auth = await getAuth();
  let signalConfig;
  try {
    if (serverUrl) {
      const cfg = await PeerCastApi.getConfig(serverUrl);
      const s = cfg?.signal;
      if (s) {
        signalConfig = {
          host: s.host,
          port: s.port,
          path: s.path,
          key: s.key,
          secure: s.secure,
        };
        // Pass an opaque, short-lived signaling ticket (never the raw JWT) as
        // the PeerJS token so the signaling server can evict banned hosts at
        // the handshake without exposing the JWT in the WebSocket URL / logs.
        if (auth?.token) {
          try {
            const ticket = await PeerCastApi.getSignalingTicket(
              serverUrl,
              auth.token,
            );
            if (ticket?.token) signalConfig.token = ticket.token;
          } catch (err) {
            console.warn(
              "PeerCast: could not mint a signaling ticket:",
              err?.message,
            );
          }
        }
        if (Array.isArray(s.iceServers) && s.iceServers.length) {
          signalConfig.config = { iceServers: s.iceServers };
        }
      }
    }
  } catch (err) {
    console.warn("PeerCast: could not fetch server config:", err?.message);
  }
  return {
    target: "offscreen",
    type: "START",
    streamId,
    desktop: !!meta.desktop,
    tabId: meta.tabId,
    hasSystemAudio: meta.hasSystemAudio,
    signalConfig,
    qualityCaps: await getQualityCaps(),
    accessPolicy: meta.access || "public",
    serverUrl,
    debug: !!(await chrome.storage.local.get("debugLog"))?.debugLog,
    tabTitle: meta.title,
    tabUrl: meta.url,
    favIconUrl: meta.favIconUrl,
  };
}

// ─── Capture token minting ────────────────────────────────────────────────────

async function mintStreamIdWithRetry(tabId) {
  const MINT_TIMEOUT_MS = 4000;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const attempt = () =>
    Promise.race([
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
      wait(MINT_TIMEOUT_MS).then(() => {
        throw new Error("tabCapture token mint timed out");
      }),
    ]);
  try {
    return await attempt();
  } catch (firstErr) {
    await wait(1500);
    try {
      return await attempt();
    } catch {
      throw firstErr;
    }
  }
}

// ─── Broadcast start ──────────────────────────────────────────────────────────

async function startCastForTab(tab) {
  try {
    if (!(await isSignedIn())) {
      await openPopupSoon();
      return;
    }
    const streamId = await mintStreamIdWithRetry(tab.id);
    await ensureOffscreenDocument();
    // Default pending metadata for the keyboard path (popup overrides it).
    const pending = await getPendingBroadcast();
    await setPendingBroadcast({
      title: pending.title || tab.title || "Live broadcast",
      access: pending.access || "public",
      accessCode: pending.accessCode,
      source: "tab",
    });
    await setSession({
      status: "starting",
      error: null,
      endedReason: null,
      sourceLabel: null,
      tabTitle: tab.title,
      tabUrl: tab.url,
      favIconUrl: tab.favIconUrl,
    });
    await chrome.runtime.sendMessage(
      await buildStartPayload(streamId, {
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        access: pending.access || "public",
      }),
    );
    await openPopupSoon();
  } catch (err) {
    await setSession({
      status: "error",
      error: "Could not start capture: " + String(err?.message || err),
    });
  }
}

async function startCastForDesktop(streamId, canRequestAudioTrack) {
  try {
    await ensureOffscreenDocument();
    const pending = await getPendingBroadcast();
    await setPendingBroadcast({
      title: pending.title || "Screen / window share",
      access: pending.access || "public",
      accessCode: pending.accessCode,
      source: "screen",
    });
    await setSession({
      status: "starting",
      error: null,
      endedReason: null,
      sourceLabel: null,
      tabTitle: "Screen / window share",
      tabUrl: null,
      favIconUrl: null,
    });
    await chrome.runtime.sendMessage(
      await buildStartPayload(streamId, {
        desktop: true,
        hasSystemAudio: !!canRequestAudioTrack,
        title: "Screen / window share",
        access: pending.access || "public",
      }),
    );
    await openPopupSoon();
  } catch (err) {
    await setSession({
      status: "error",
      error: "Could not start capture: " + String(err?.message || err),
    });
    await openPopupSoon();
  }
}

// ─── Broadcast stop ───────────────────────────────────────────────────────────

async function stopBroadcast() {
  try {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 4000);
      chrome.runtime
        .sendMessage({ target: "offscreen", type: "STOP" })
        .then(() => {
          clearTimeout(t);
          resolve();
        })
        .catch(() => {
          clearTimeout(t);
          resolve();
        });
    });
  } catch {
    /* offscreen already gone */
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* nothing to close */
  }

  backendEnd().catch(() => {});

  await setSession({
    status: "idle",
    peerId: null,
    broadcastId: null,
    startedAt: null,
    viewers: 0,
    bitrateKbps: null,
    error: null,
    lastWarning: null,
    endedReason: null,
  });
}

// ─── Popup helper ─────────────────────────────────────────────────────────────

async function openPopupSoon() {
  try {
    const p = chrome.action.openPopup();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* older Chrome without promise form */
  }
}

// ─── Message bus ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "background") return false;

  if (msg.type === "STATE_PATCH") {
    setSession(msg.patch || {});
    if (msg.patch && ("viewers" in msg.patch || "bitrateKbps" in msg.patch)) {
      forwardStats(msg.patch).catch(() => {});
    }
    return false;
  }

  // Offscreen signals go-live with its backend-assigned peer id.
  if (msg.type === "ANNOUNCE_SESSION") {
    if (msg.peerId) backendStart(msg.peerId).catch(() => {});
    return false;
  }

  // Store JWT + server URL after popup login.
  if (msg.type === "STORE_AUTH") {
    (async () => {
      try {
        if (msg.auth?.token && msg.auth?.username) {
          await setAuth({ token: msg.auth.token, username: msg.auth.username });
          if (typeof msg.serverUrl === "string") {
            await chrome.storage.local.set({
              serverUrl: msg.serverUrl.trim().replace(/\/$/, ""),
            });
          }
        } else {
          await clearAuth();
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message });
      }
    })();
    return true;
  }

  if (msg.type === "SIGN_OUT") {
    (async () => {
      try {
        const session = await getSession();
        if (session.status === "live" || session.status === "starting") {
          await stopBroadcast();
        }
        await clearAuth();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message });
      }
    })();
    return true;
  }

  if (msg.type === "GET_PROFILE") {
    (async () => {
      try {
        const [{ serverUrl }, auth] = await Promise.all([
          chrome.storage.local.get("serverUrl"),
          getAuth(),
        ]);
        sendResponse({
          ok: true,
          serverUrl: serverUrl ?? "",
          loggedIn: !!auth,
          username: auth?.username ?? null,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message });
      }
    })();
    return true;
  }

  // Persist chosen broadcast metadata (title/access/code) from the popup.
  if (msg.type === "SET_BROADCAST_META") {
    (async () => {
      try {
        await setPendingBroadcast(msg.meta || {});
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message });
      }
    })();
    return true;
  }

  if (msg.type === "STOP_BROADCAST") {
    stopBroadcast()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "START_TAB_CAST") {
    (async () => {
      try {
        if (!(await isSignedIn())) {
          sendResponse({
            ok: false,
            error: "You must be signed in before starting a broadcast.",
          });
          return;
        }
        await ensureOffscreenDocument();
        await setPendingBroadcast({
          title: msg.title || msg.tabTitle || "Live broadcast",
          access: msg.access || "public",
          accessCode: msg.accessCode,
          source: "tab",
        });
        await setSession({
          status: "starting",
          error: null,
          endedReason: null,
          sourceLabel: null,
          tabTitle: msg.tabTitle,
          tabUrl: msg.tabUrl,
          favIconUrl: msg.favIconUrl,
        });
        await chrome.runtime.sendMessage(
          await buildStartPayload(msg.streamId, {
            tabId: msg.tabId,
            access: msg.access,
            title: msg.tabTitle,
            url: msg.tabUrl,
            favIconUrl: msg.favIconUrl,
          }),
        );
        sendResponse({ ok: true });
      } catch (err) {
        await setSession({
          status: "error",
          error: "Could not start capture: " + String(err?.message || err),
        });
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === "GET_STREAM_ID" && msg.tabId != null) {
    chrome.tabCapture
      .getMediaStreamId({ targetTabId: msg.tabId })
      .then((id) => sendResponse({ ok: true, streamId: id }))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message || err) }),
      );
    return true;
  }

  if (msg.type === "PICK_DESKTOP_MEDIA") {
    (async () => {
      const session = await getSession();
      if (session.status === "live" || session.status === "starting") {
        sendResponse?.({ ok: false, error: "A broadcast is already running." });
        await openPopupSoon();
        return;
      }
      if (msg.meta) await setPendingBroadcast(msg.meta);

      let settled = false;
      const requestId = chrome.desktopCapture.chooseDesktopMedia(
        ["screen", "window"],
        (id, opts = {}) => {
          clearTimeout(pickerTimeout);
          settled = true;
          if (id) startCastForDesktop(id, !!opts.canRequestAudioTrack);
        },
      );

      if (!requestId && !settled) {
        sendResponse?.({
          ok: false,
          error:
            "The screen picker could not be opened. " +
            (chrome.runtime.lastError?.message || ""),
        });
        return;
      }
      sendResponse?.({ picking: true });

      const pickerTimeout = setTimeout(async () => {
        if (!settled) {
          settled = true;
          try {
            chrome.desktopCapture.cancelChooseDesktopMedia(requestId);
          } catch {
            /* already gone */
          }
          await setSession({
            status: "error",
            error:
              "The screen picker timed out without a selection. Please try again.",
          });
          await openPopupSoon();
        }
      }, 120_000);
    })();
    return true;
  }

  return false;
});

// ─── Keyboard commands ────────────────────────────────────────────────────────

async function resolveCommandTargetTab() {
  const query = (q) =>
    new Promise((resolve) =>
      chrome.tabs.query(q, (tabs) => resolve(tabs || [])),
    );
  let [tab] = await query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) return tab;
  await new Promise((r) => setTimeout(r, 350));
  [tab] = await query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) return tab;
  [tab] = await query({ active: true });
  return tab?.id != null ? tab : null;
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== "start-cast" && command !== "toggle-cast") return;
  resolveCommandTargetTab().then(async (tab) => {
    if (tab?.id == null) {
      await setSession({
        status: "error",
        error: "No active browser tab to capture.",
      });
      return;
    }
    if (command === "toggle-cast") {
      const { status } = await getSession();
      if (status === "live" || status === "starting") {
        await stopBroadcast();
        return;
      }
    }
    await startCastForTab(tab);
  });
});
