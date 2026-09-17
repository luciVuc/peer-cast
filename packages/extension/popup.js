/**
 * PeerCast popup — self-hosted backend edition.
 *
 * Flow:
 *   1. Sign in with server URL + username + password (JWT via the backend).
 *   2. Choose title + access policy, then broadcast a tab or your screen.
 *   3. Live view shows viewers/bitrate + a copyable viewer link, plus Stop.
 *
 * The popup mints the tabCapture token under the genuine click (the required
 * user-gesture grant) and delegates everything else to the service worker.
 */

/* global PeerCastApi */

const $ = (id) => document.getElementById(id);
const bg = (msg) =>
  chrome.runtime.sendMessage({ target: "background", ...msg });

const views = {
  signIn: $("viewSignIn"),
  controls: $("viewControls"),
  live: $("viewLive"),
  starting: $("starting"),
};

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
}

let serverUrl = "";
let username = "";
let pollTimer = null;

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const profile = await bg({ type: "GET_PROFILE" });
  serverUrl = profile?.serverUrl || "";
  username = profile?.username || "";
  if (serverUrl) $("serverInput").value = serverUrl;
  if (username) $("usernameInput").value = username;

  if (profile?.loggedIn) {
    enterSignedIn();
  } else {
    show("signIn");
  }
}

function enterSignedIn() {
  $("hdrHandle").textContent = "@" + username;
  $("hdrServer").textContent = serverUrl;
  refreshFromSession();
  startPolling();
}

// ─── Session polling ─────────────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refreshFromSession, 1000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshFromSession() {
  const { session } = await chrome.storage.local.get("session");
  const s = session || { status: "idle" };

  if (s.status === "live") {
    show("live");
    $("statViewers").textContent = String(s.viewers ?? 0);
    $("statBitrate").textContent =
      s.bitrateKbps == null ? "—" : String(s.bitrateKbps);
    $("sourceLabel").textContent = s.sourceLabel || s.tabTitle || "";
    $("viewerLink").value = `${serverUrl}/watch/${username}`;
    if (s.lastWarning) {
      $("liveWarning").hidden = false;
      $("liveWarning").textContent = s.lastWarning;
    } else {
      $("liveWarning").hidden = true;
    }
  } else if (s.status === "starting") {
    show("starting");
  } else {
    show("controls");
    if (s.error) {
      $("controlsError").hidden = false;
      $("controlsError").textContent = s.error;
    } else if (s.endedReason) {
      $("controlsError").hidden = false;
      $("controlsError").textContent = s.endedReason;
    } else {
      $("controlsError").hidden = true;
    }
  }
}

// ─── Sign in ─────────────────────────────────────────────────────────────────

$("signInBtn").addEventListener("click", async () => {
  const url = $("serverInput").value.trim().replace(/\/$/, "");
  const user = $("usernameInput").value.trim();
  const pass = $("passwordInput").value;
  const err = $("signInError");
  err.hidden = true;
  if (!url || !user || !pass) {
    err.hidden = false;
    err.textContent = "Server URL, username and password are required.";
    return;
  }
  // Request the narrowest host permission for this specific origin.
  let origin;
  try {
    const parsed = new URL(url);
    const local =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]" ||
      parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
      throw new Error("Remote PeerCast servers must use HTTPS.");
    }
    origin = parsed.origin + "/*";
  } catch {
    err.hidden = false;
    err.textContent = "Use an HTTPS server URL (HTTP is allowed only on localhost).";
    return;
  }
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    err.hidden = false;
    err.textContent = "Permission to access the server URL was denied.";
    return;
  }
  $("signInBtn").disabled = true;
  $("signInBtn").textContent = "Signing in…";
  try {
    const res = await PeerCastApi.login(url, user, pass);
    serverUrl = url;
    username = res.user.username;
    await bg({
      type: "STORE_AUTH",
      auth: { token: res.accessToken, username: res.user.username },
      serverUrl: url,
    });
    enterSignedIn();
  } catch (e) {
    err.hidden = false;
    err.textContent =
      e.status === 401
        ? "Invalid credentials."
        : e.message || "Sign in failed.";
  } finally {
    $("signInBtn").disabled = false;
    $("signInBtn").textContent = "Sign in";
  }
});

// ─── Sign out ────────────────────────────────────────────────────────────────

$("signOutBtn").addEventListener("click", async () => {
  await bg({ type: "SIGN_OUT" });
  stopPolling();
  $("passwordInput").value = "";
  show("signIn");
});

// ─── Access policy UI ────────────────────────────────────────────────────────

$("accessSelect").addEventListener("change", () => {
  $("codeRow").hidden = $("accessSelect").value !== "code";
});

function chosenMeta() {
  const access = $("accessSelect").value;
  return {
    title: $("titleInput").value.trim() || "Live broadcast",
    access,
    accessCode: access === "code" ? $("codeInput").value.trim() : undefined,
  };
}

function validateMeta(meta) {
  if (meta.access === "code" && !meta.accessCode) {
    $("controlsError").hidden = false;
    $("controlsError").textContent = "Enter an access code first.";
    return false;
  }
  return true;
}

// ─── Broadcast this tab ──────────────────────────────────────────────────────

$("startTabBtn").addEventListener("click", async () => {
  const meta = chosenMeta();
  if (!validateMeta(meta)) return;
  $("controlsError").hidden = true;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("No active tab.");
    // Mint the capture token under this genuine click (required grant).
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });
    const res = await bg({
      type: "START_TAB_CAST",
      streamId,
      tabId: tab.id,
      tabTitle: tab.title,
      tabUrl: tab.url,
      favIconUrl: tab.favIconUrl,
      title: meta.title,
      access: meta.access,
      accessCode: meta.accessCode,
    });
    if (!res?.ok) throw new Error(res?.error || "Could not start.");
  } catch (e) {
    $("controlsError").hidden = false;
    $("controlsError").textContent = e.message || String(e);
  }
});

// ─── Broadcast screen ──────────────────────────────────────────────────────────

$("shareScreenBtn").addEventListener("click", async () => {
  const meta = chosenMeta();
  if (!validateMeta(meta)) return;
  $("controlsError").hidden = true;
  const res = await bg({
    type: "PICK_DESKTOP_MEDIA",
    meta: { ...meta, source: "screen" },
  });
  if (res && res.ok === false) {
    $("controlsError").hidden = false;
    $("controlsError").textContent = res.error || "Could not open picker.";
  } else {
    // The picker steals focus and closes the popup; the offscreen host takes
    // over from here and the popup will reflect live state on next open.
    window.close();
  }
});

// ─── Stop / copy ─────────────────────────────────────────────────────────────

$("stopBtn").addEventListener("click", async () => {
  await bg({ type: "STOP_BROADCAST" });
  refreshFromSession();
});

$("copyLinkBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("viewerLink").value);
  $("copyLinkBtn").textContent = "Copied";
  setTimeout(() => ($("copyLinkBtn").textContent = "Copy"), 1500);
});

init();
