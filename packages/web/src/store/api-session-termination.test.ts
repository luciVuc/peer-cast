/**
 * Regression guard: a dead session must stop the media.
 *
 * When an access token expires mid-broadcast, RTK Query's reauth wrapper tries
 * a refresh; when the refresh token is also gone (expired, rotation family
 * revoked, or the account was banned) it falls into the "give up" branch. That
 * branch used to clear auth state and the API cache only.
 *
 * The broadcast itself lives outside Redux in the `broadcastService` module
 * singleton (BroadcastHost + MediaStream — neither is serialisable), so
 * nothing stopped them: the camera indicator stayed on, the peer kept
 * answering PeerJS calls, and viewers kept receiving the stream while the UI
 * had already bounced the broadcaster to /login. The explicit sign-out path in
 * Layout.tsx already called `broadcastService.cleanup()` for exactly this
 * reason, so the omission here was an oversight rather than a decision.
 *
 * The invariant: media lifetime is bounded by session lifetime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureStore } from "@reduxjs/toolkit";

// Mock the singleton before api.ts imports it.
const cleanup = vi.fn();
vi.mock("../lib/broadcastService", () => ({
  broadcastService: {
    get host() {
      return null;
    },
    get stream() {
      return null;
    },
    setHost: vi.fn(),
    setStream: vi.fn(),
    cleanup: () => cleanup(),
  },
}));

import { api } from "./api";
import authReducer, { loggedIn } from "./authSlice";
import broadcastReducer from "./broadcastSlice";

// fetchBaseQuery builds `new Request(url, config)` internally and Node's
// Request rejects the relative `/api/...` URLs, so resolve them first.
const NativeRequest = globalThis.Request;

let fetchMock: ReturnType<typeof vi.fn>;

function makeStore() {
  return configureStore({
    reducer: {
      auth: authReducer,
      broadcast: broadcastReducer,
      [api.reducerPath]: api.reducer,
    },
    middleware: (gdm) => gdm().concat(api.middleware),
  });
}

describe("session death stops the broadcast", () => {
  beforeEach(() => {
    cleanup.mockClear();
    class Req extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === "string" && input.startsWith("/")
            ? `https://example.test${input}`
            : (input as RequestInfo | URL),
          init,
        );
      }
    }
    globalThis.Request = Req;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.Request = NativeRequest;
  });

  it("cleans up media when the refresh token is also dead", async () => {
    const store = makeStore();
    store.dispatch(
      loggedIn({
        accessToken: "expired",
        user: {
          username: "alice",
          displayName: "Alice",
          about: null,
          avatarUrl: null,
          createdAt: 1,
          email: "alice@example.com",
          role: "user",
          emailVerified: false,
          updatedAt: 1,
        },
      }),
    );

    // The endpoint 401s, and the refresh attempt fails too (401 as well) —
    // the "session is gone for good" path.
    // fetchBaseQuery calls fetch(new Request(...)), so the first argument is a
    // Request instance — normalise before matching on the path.
    const pathOf = (u: unknown) =>
      typeof u === "string"
        ? u
        : u instanceof NativeRequest
          ? u.url
          : String((u as { url?: string })?.url ?? u);

    fetchMock.mockImplementation(async (url: unknown) => {
      if (pathOf(url).includes("/api/auth/refresh")) {
        return new Response(JSON.stringify({ error: "nope" }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    });

    await store.dispatch(api.endpoints.getMe.initiate(undefined));

    // Assert on observable store state rather than the query result:
    // resetApiState() below removes the query before the initiate() promise
    // settles, so `res` comes back empty and is not a reliable signal.
    // The camera must be released — this is the whole point.
    expect(cleanup).toHaveBeenCalledTimes(1);
    // …and the session must actually be gone, not left half-authenticated.
    expect(store.getState().auth.accessToken).toBeNull();
  });

  it("does not tear down media when a refresh succeeds", async () => {
    const store = makeStore();
    store.dispatch(
      loggedIn({
        accessToken: "stale",
        user: {
          username: "alice",
          displayName: "Alice",
          about: null,
          avatarUrl: null,
          createdAt: 1,
          email: "alice@example.com",
          role: "user",
          emailVerified: false,
          updatedAt: 1,
        },
      }),
    );

    let profileCalls = 0;
    // fetchBaseQuery calls fetch(new Request(...)), so the first argument is a
    // Request instance — normalise before matching on the path.
    const pathOf = (u: unknown) =>
      typeof u === "string"
        ? u
        : u instanceof NativeRequest
          ? u.url
          : String((u as { url?: string })?.url ?? u);

    fetchMock.mockImplementation(async (url: unknown) => {
      if (pathOf(url).includes("/api/auth/refresh")) {
        return new Response(JSON.stringify({ accessToken: "fresh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      profileCalls++;
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    });

    await store.dispatch(api.endpoints.getMe.initiate(undefined));

    // Refresh worked, so the session survives — a broadcaster whose token was
    // merely stale must NOT have their stream killed underneath them.
    expect(cleanup).not.toHaveBeenCalled();
    expect(store.getState().auth.accessToken).toBe("fresh");
    expect(profileCalls).toBeGreaterThan(0);
  });
});
