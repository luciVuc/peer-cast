import { describe, expect, it } from "vitest";
import { CHAT_MAX_LENGTH } from "@peer-cast/shared";
import {
  capForTier,
  effectiveBudgetKbps,
  packChat,
  sanitizeChat,
  tierForViewer,
  unpackChat,
} from "./peer";

describe("chat protocol", () => {
  it("round-trips a chat line through the wire format", () => {
    const line = JSON.stringify(packChat("alice", "hello world"));
    const msg = unpackChat(line);
    expect(msg).toMatchObject({
      kind: "chat",
      from: "alice",
      text: "hello world",
    });
    expect(msg?.id).toBeTruthy();
    expect(msg?.ts).toBeGreaterThan(0);
  });

  it("rejects non-chat payloads", () => {
    expect(unpackChat("not json")).toBeNull();
    expect(unpackChat(JSON.stringify({ kind: "ping" }))).toBeNull();
    expect(unpackChat(JSON.stringify({ kind: "chat", text: 42 }))).toBeNull();
    expect(unpackChat(null)).toBeNull();
  });
});

describe("chat sanitization (host relay)", () => {
  it("attributes to the verified ticket name, never the wire `from`", () => {
    // A malicious viewer forging the host's name must be relabelled.
    const spoofed = packChat("Host", "drop your Discord keys");
    const out = sanitizeChat(spoofed, "alice");
    expect(out.from).toBe("alice");
    expect(out.text).toBe("drop your Discord keys");
  });

  it("falls back to Viewer when no verified identity exists", () => {
    const out = sanitizeChat(packChat("Alice", "hi"));
    expect(out.from).toBe("Viewer");
  });

  it("truncates over-long lines to CHAT_MAX_LENGTH", () => {
    const long = "x".repeat(CHAT_MAX_LENGTH + 100);
    const out = sanitizeChat(packChat("alice", long), "alice");
    expect(out.text.length).toBe(CHAT_MAX_LENGTH);
  });
});

// ─── Bitrate shaping policy ───────────────────────────────────────────────
//
// These cover the pure decision functions only. Whether `setParameters`
// actually caps a real sender cannot be verified in jsdom — that needs a
// Playwright run against a live connection. What IS verifiable here is that
// the policy never makes a decision that breaks the broadcast.

describe("tier ladder", () => {
  it("gives the first viewers the top of the ladder, uncapped", () => {
    // Index 0 is deliberately uncapped: with budget to spare, viewers should
    // get the host's natural quality rather than an artificial ceiling.
    expect(tierForViewer(0, [2500, 1200, 600])).toBe(0);
    expect(tierForViewer(1, [2500, 1200, 600])).toBe(1);
    expect(capForTier(0, [2500, 1200, 600])).toBeNull();
  });

  it("keeps descending as the audience grows", () => {
    const tiers = [2500, 1200, 600, 300];
    expect(tierForViewer(2, tiers)).toBe(2);
    expect(capForTier(2, tiers)).toBe(600);
    expect(tierForViewer(3, tiers)).toBe(3);
    expect(capForTier(3, tiers)).toBe(300);
  });

  it("does not run out — extra viewers bottom out rather than being refused", () => {
    const tiers = [2500, 1200, 600];
    // The single most important property here: a 500th viewer is still
    // admitted. Refusing them would be admission control, which this policy
    // deliberately is not.
    for (const n of [4, 50, 500, 100_000]) {
      expect(tierForViewer(n, tiers)).toBe(2);
      expect(capForTier(tierForViewer(n, tiers), tiers)).toBe(600);
    }
  });

  it("never returns a tier outside the ladder", () => {
    expect(tierForViewer(0, [])).toBe(0);
    expect(capForTier(9, [])).toBeNull();
    expect(capForTier(-1, [2500, 1200])).toBeNull();
  });
});

describe("effective budget", () => {
  it("falls back to the configured budget when the browser reports nothing", () => {
    expect(effectiveBudgetKbps(6000, null, 0.8)).toBe(6000);
    expect(effectiveBudgetKbps(6000, 0, 0.8)).toBe(6000);
    expect(effectiveBudgetKbps(6000, NaN, 0.8)).toBe(6000);
  });

  it("tightens to measured headroom when it is below the configured ceiling", () => {
    // Link can only sustain 2000 kbps; commit to 80% of it, not the full 2000.
    expect(effectiveBudgetKbps(6000, 2000, 0.8)).toBe(1600);
  });

  it("never WIDENS the budget past what the operator configured", () => {
    // An optimistic availableOutgoingBitrate spike must not buy more than
    // the operator allowed — the measurement is advisory, the config is not.
    expect(effectiveBudgetKbps(6000, 50_000, 0.8)).toBe(6000);
  });

  it("never returns a non-positive budget, which would stall every viewer", () => {
    // A tiny measured value must not produce a 1 kbps budget: with the cap set
    // that low the encoder produces almost nothing and every viewer stalls.
    const b = effectiveBudgetKbps(6000, 1, 0.8);
    expect(b).toBeGreaterThan(0);
  });
});
