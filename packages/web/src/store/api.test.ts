/**
 * Regression coverage for the account-switch bug: after login → logout →
 * login#2, the API cache must not keep serving the first account's profile.
 * (Previously `useGetMeQuery` returned the cached old user for up to
 * `keepUnusedDataFor`, and BroadcastPage baked that stale username into the
 * viewer link: `/watch/<oldUser>`.)
 *
 * The app defends on three layers, all exercised here:
 *   1. `loggedOut` + `api.util.resetApiState()` on sign-out wipes the cache.
 *   2. login/register invalidate the `Me` tag.
 *   3. `goLive` takes the viewer username from the server's start response
 *      (covered separately in BroadcastPage; not unit-tested here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import type {
  AccessPolicy,
  AuthResponse,
  SelfProfileResponse,
  SelfUser,
} from "@peer-cast/shared";
import { api } from "./api";
import authReducer, { loggedIn, loggedOut } from "./authSlice";

// fetchBaseQuery builds `new Request(url, config)` internally; Node's Request
// rejects relative URLs (`/api/...`), so we wrap it in one that resolves them
// against a throwaway origin before delegating to the native constructor.
const NativeRequest = globalThis.Request;

function makeUser(username: string): SelfUser {
  return {
    username,
    displayName: username,
    about: null,
    avatarUrl: null,
    createdAt: 1,
    email: `${username}@example.com`,
    role: "user",
    emailVerified: false,
    updatedAt: 1,
  };
}

function profile(user: SelfUser): SelfProfileResponse {
  return {
    user,
    settings: {
      defaultAccess: "public" as AccessPolicy,
      defaultTitle: "Live broadcast",
      discoverable: true,
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function makeStore() {
  return configureStore({
    reducer: {
      auth: authReducer,
      [api.reducerPath]: api.reducer,
    },
    middleware: (gdm) => gdm().concat(api.middleware),
  });
}

describe("api cache across account switches", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "Request",
      class TestRequest {
        private native: Request;
        constructor(input: string | URL | Request, init?: RequestInit) {
          const raw = String(input);
          const url = /^https?:\/\//.test(raw)
            ? raw
            : `http://test.local${raw.startsWith("/") ? "" : "/"}${raw}`;
          this.native = new NativeRequest(url, init);
        }
        get url() {
          return this.native.url;
        }
        get method() {
          return this.native.method;
        }
        get headers() {
          return this.native.headers;
        }
        text() {
          return this.native.text();
        }
        json() {
          return this.native.json();
        }
      } as unknown as typeof Request,
    );

    // Fake backend: /auth/login takes {username} → returns a token for that
    // user; /users/me echoes the user matching the Bearer token.
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      const url = req.url;
      if (url.endsWith("/auth/login")) {
        const body = JSON.parse(await req.text()) as { username?: string };
        const username = body.username ?? "unknown";
        const res: AuthResponse = {
          accessToken: `token-${username}`,
          user: makeUser(username),
        };
        return json(res);
      }
      if (url.endsWith("/users/me")) {
        const token =
          req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
        const username =
          token === "token-bob"
            ? "bob"
            : token === "token-alice"
              ? "alice"
              : "unknown";
        return json(profile(makeUser(username)));
      }
      return json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("after logout + second login, getMe returns the new account, not the cached one", async () => {
    const store = makeStore();

    // Alice's session: the getMe query caches her profile.
    store.dispatch(
      loggedIn({ accessToken: "token-alice", user: makeUser("alice") }),
    );
    await store.dispatch(api.endpoints.getMe.initiate());
    expect(
      api.endpoints.getMe.select()(store.getState()).data?.user.username,
    ).toBe("alice");
    expect(
      api.endpoints.getMe.select()(store.getState()).data?.user.email,
    ).toBe("alice@example.com");

    // Sign-out path used by Layout: loggedOut + full API cache reset.
    store.dispatch(loggedOut());
    store.dispatch(api.util.resetApiState());
    expect(
      Object.keys(store.getState()[api.reducerPath].queries ?? {}),
    ).toHaveLength(0);
    expect(api.endpoints.getMe.select()(store.getState()).data).toBeUndefined();

    // Bob signs in — through the real login mutation (invalidatesTags(["Me"])),
    // then the getMe query mounts again and must REFETCH bob, not resurrect
    // the cached alice.
    const login = await store.dispatch(
      api.endpoints.login.initiate({ username: "bob", password: "secret123" }),
    );
    expect(login.data?.accessToken).toBe("token-bob");
    store.dispatch(loggedIn(login.data!));
    await store.dispatch(api.endpoints.getMe.initiate());

    expect(
      api.endpoints.getMe.select()(store.getState()).data?.user.username,
    ).toBe("bob");
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String((input as Request).url).endsWith("/users/me"),
      ),
    ).toHaveLength(2);
  });

  it("resetting the cache also drops broadcasts/other user-owned data", async () => {
    const store = makeStore();
    store.dispatch(
      loggedIn({ accessToken: "token-alice", user: makeUser("alice") }),
    );
    await store.dispatch(api.endpoints.listLive.initiate());
    expect(
      Object.keys(store.getState()[api.reducerPath].queries ?? {}).length,
    ).toBeGreaterThan(0);

    store.dispatch(loggedOut());
    store.dispatch(api.util.resetApiState());
    expect(store.getState()[api.reducerPath].queries).toEqual({});
  });
});
