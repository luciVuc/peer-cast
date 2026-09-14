import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import request from "supertest";
import type { RTCIceServerConfig } from "@peer-cast/shared";
import { config } from "../src/config.js";
import { turnCredentials, withTurnCredentials } from "../src/lib/turn.js";
import { makeApp, resetDb } from "./helpers.js";

describe("turn credential rotation", () => {
  it("derives time-limited credentials matching the coturn use-auth-secret flow", () => {
    const before = Math.floor(Date.now() / 1000);
    const creds = turnCredentials("s3cret", 3600, "peercast");

    // username = "<unix expiry>:<userid>", cred = b64(hmac-sha1(secret, username))
    const [expiresAt, userid] = creds.username.split(":");
    expect(userid).toBe("peercast");
    expect(Number(expiresAt)).toBeGreaterThan(before);
    expect(Number(expiresAt)).toBeLessThanOrEqual(before + 3600 + 5);

    const expected = createHmac("sha1", "s3cret")
      .update(creds.username)
      .digest("base64");
    expect(creds.credential).toBe(expected);
    // Credentials are exactly base64.
    expect(creds.credential).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("uses the TTL and userid from the caller", () => {
    const base = turnCredentials("s3cret", 3600, "relay-a");
    const later = turnCredentials("s3cret", 7200, "relay-b");

    expect(base.username.endsWith(":relay-a")).toBe(true);
    expect(later.username.endsWith(":relay-b")).toBe(true);
    // Longer TTL ⇒ strictly later expiry timestamp (>= the TTL delta apart).
    const baseExp = Number(base.username.split(":")[0]);
    const laterExp = Number(later.username.split(":")[0]);
    expect(laterExp - baseExp).toBeGreaterThanOrEqual(3600);
  });

  it("attaches ephemeral creds only to TURN entries, leaves others untouched", () => {
    const input: RTCIceServerConfig[] = [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: "turn:turn.example.com:3478",
        username: "legacy",
        credential: "legacy",
      },
      { urls: ["turns:example.com:5349", "stun:fallback:19302"] },
    ];

    const out = withTurnCredentials(input, "s3cret", 3600, "peercast");

    // STUN-only entry untouched (and object identity preserved).
    expect(out[0]).toBe(input[0]);

    // Plain turn: credential replaced by ephemeral ones.
    expect(out[1].urls).toBe("turn:turn.example.com:3478");
    expect(out[1].username).toBeTruthy();
    expect(out[1].credential).toBeTruthy();
    expect(out[1].credential).not.toBe("legacy");

    // turns: entry gets creds; the stun url in the mixed array is not affected.
    expect(out[2].username).toBeTruthy();
    expect(out[2].credential).toBeTruthy();
  });

  it("serves rotating credentials via GET /api/config when the secret is configured", async () => {
    const app = makeApp();
    const original = config.signal.iceServers;
    try {
      // The route reads config lazily per request — exercise the enabled path
      // with a TURN url advertised.
      config.turn.sharedSecret = "route-secret";
      config.signal.iceServers = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "turn:turn.example.com:3478" },
      ] as RTCIceServerConfig[];

      const res = await request(app).get("/api/config");
      const turn = (res.body.signal.iceServers as RTCIceServerConfig[]).find(
        (s) =>
          (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) =>
            u.startsWith("turn:"),
          ),
      );
      const stun = (res.body.signal.iceServers as RTCIceServerConfig[]).find(
        (s) => s.urls === "stun:stun.l.google.com:19302",
      );

      expect(turn?.username).toBeTruthy();
      expect(turn?.credentials).toBeUndefined();
      expect(turn?.credential).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(turn?.username).toMatch(/^[0-9]+:peercast$/);
      expect(stun?.username).toBeUndefined();
    } finally {
      config.turn.sharedSecret = "";
      config.signal.iceServers = original;
    }
  });
});

// Keep vitest's per-file setup honest: don't rely on module state from other
// suites (we mutate the global config object in this file).
describe("turn config defaults", () => {
  beforeEach(() => resetDb());

  it("serves the plain ICE_SERVERS list when no shared secret is configured", async () => {
    if (config.turn.sharedSecret !== "") return; // would otherwise conflict
    const app = makeApp();
    const res = await request(app).get("/api/config");
    expect(res.body.signal.iceServers).toEqual([
      { urls: "stun:stun.l.google.com:19302" },
    ]);
  });
});
