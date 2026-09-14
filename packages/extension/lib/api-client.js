/**
 * PeerCast extension API client.
 *
 * Talks to the self-hosted PeerCast backend (Express API) instead of the old
 * Cloudflare registry. Loaded via importScripts() in the service worker and a
 * <script> tag in the offscreen document, so it exposes a global object and
 * uses no ES module syntax.
 *
 * Base URL is the backend origin, e.g. "https://peercast.example.com" (no
 * trailing slash). All endpoints live under `${base}/api`.
 */

(function (global) {
  function apiUrl(base, path) {
    return `${base.replace(/\/$/, "")}/api${path}`;
  }

  async function request(base, path, { method = "GET", token, body } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(apiUrl(base, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const PeerCastApi = {
    /** Public runtime config incl. PeerJS signaling params. */
    getConfig(base) {
      return request(base, "/config");
    },

    /** Authenticate; returns { accessToken, refreshToken, user }. */
    login(base, username, password) {
      return request(base, "/auth/login", {
        method: "POST",
        body: { username, password },
      });
    },

    /** Mint a short-lived, single-use opaque signaling ticket for the PeerJS
     * WebSocket URL. The raw JWT must never appear in a URL query string — it
     * would leak via reverse-proxy access logs. Returns { token }. */
    getSignalingTicket(base, token) {
      return request(base, "/auth/signaling-ticket", {
        method: "POST",
        token,
      });
    },

    /** Create a live broadcast record; returns { broadcast }. */
    startBroadcast(base, token, payload) {
      return request(base, "/broadcasts", {
        method: "POST",
        token,
        body: payload,
      });
    },

    /** End a live broadcast. */
    endBroadcast(base, token, id) {
      return request(base, `/broadcasts/${id}/end`, {
        method: "POST",
        token,
      });
    },

    /** Push a live stats heartbeat. */
    updateStats(base, token, id, stats) {
      return request(base, `/broadcasts/${id}/stats`, {
        method: "POST",
        token,
        body: { stats },
      });
    },

    /** Host verifies a viewer's short-lived access ticket. */
    verifyTicket(base, ticket, peerId) {
      return request(base, "/sessions/verify-ticket", {
        method: "POST",
        body: { ticket, peerId },
      });
    },
  };

  global.PeerCastApi = PeerCastApi;
})(typeof self !== "undefined" ? self : this);
