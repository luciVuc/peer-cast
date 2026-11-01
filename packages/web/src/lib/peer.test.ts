import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Peer from "peerjs";
import { CHAT_MAX_LENGTH } from "@peer-cast/shared";
import {
  BroadcastHost,
  capForTier,
  effectiveBudgetKbps,
  packChat,
  sanitizeChat,
  tierForViewer,
  unpackChat,
} from "./peer";
import type { HostStats } from "./peer";

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

// ─── BroadcastHost noop-viewer heartbeat regression ──────────────────────
//
// Regression guard for the "host streams forever with nobody watching" bug:
// `BroadcastHost` used to start its 2 s stats sampler only when the first
// viewer called in. With zero viewers the host never heartbeated
// POST /api/broadcasts/:id/stats, so the server reaper force-ended the row
// after STALE_LIVE_MS and nulled the peerId — the host still saw "live" but
// no viewer could ever connect. The sampler now arms on signaling-open; this
// suite proves onStats fires (and hence a heartbeat is dispatched by
// BroadcastPage) BEFORE any viewer exists.

type FakePeerHandler = (...args: unknown[]) => void;

interface FakePeerInstance {
  id: string;
  on: (event: string, fn: FakePeerHandler) => void;
  emit: (event: string, ...args: unknown[]) => void;
  destroy: () => void;
  call?: unknown;
  connect?: unknown;
}

// Mock lives in the hoisted factory; tests grab instances off the class (via
// the mocked "peerjs" default export) so they can fire lifecycle events like
// "open".
vi.mock("peerjs", () => {
  class FakePeer {
    id: string;
    handlers = new Map<string, FakePeerHandler[]>();
    static instances: FakePeerInstance[] = [];

    constructor(id?: string) {
      this.id = id ?? "fake-peer-id";
      FakePeer.instances.push(this);
    }

    on(event: string, fn: FakePeerHandler) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }

    destroy() {
      /* noop */
    }
  }
  return { default: FakePeer };
});

function makeHost(overrides?: Partial<Record<string, unknown>>) {
  const FakePeer = Peer as unknown as {
    instances: FakePeerInstance[];
  };
  const stats: HostStats[] = [];
  const stream = {
    getVideoTracks: () => [{ getSettings: () => ({}) }],
    getAudioTracks: () => [],
  } as unknown as MediaStream;

  const host = new BroadcastHost({
    cfg: {
      signal: { path: "/peerjs", key: "peercast", iceServers: [] },
    } as never,
    peerId: "pc-test",
    stream,
    verify: async () => null,
    onStats: (s) => stats.push(s),
    ...overrides,
  });

  const inst = FakePeer.instances[FakePeer.instances.length - 1];
  return { host, stats, inst };
}

describe("BroadcastHost (mocked peerjs)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("heartbeats stats with zero viewers as soon as signaling opens", async () => {
    const { host, stats, inst } = makeHost();
    inst.emit("open");

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    // Two samples with no viewers at all: viewers=0, bitrate=null. This is
    // exactly the shape BroadcastPage forwards as the server heartbeat.
    expect(stats.length).toBe(2);
    expect(stats[0]).toMatchObject({
      viewers: 0,
      bitrateKbps: null,
      totalConnections: 0,
    });
    expect(stats[1]).toMatchObject({ viewers: 0, bitrateKbps: null });
    host.stop();
  });

  it("does not emit stats before signaling opens (no spurious heartbeats)", () => {
    const { host, stats } = makeHost();
    vi.advanceTimersByTime(10_000);
    // No "open" event: the sampler is not armed yet, and a host that failed
    // to register its peer id must not pretend to be live on the server.
    expect(stats.length).toBe(0);
    host.stop();
  });
});
