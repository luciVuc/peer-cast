import { describe, expect, it } from "vitest";
import type { AuthResponse, SelfUser } from "@peer-cast/shared";
import reducer, {
  loggedIn,
  loggedOut,
  tokensUpdated,
  userUpdated,
  setHydrated,
} from "./authSlice";

const user: SelfUser = {
  username: "alice",
  displayName: "Alice",
  about: null,
  avatarUrl: null,
  createdAt: 1,
  email: "alice@example.com",
  role: "user",
  emailVerified: false,
  updatedAt: 1,
};

const payload: AuthResponse = {
  accessToken: "acc",
  // refreshToken is no longer in AuthResponse — it lives in an HttpOnly cookie.
  user,
};

const empty = {
  accessToken: null as string | null,
  user: null as SelfUser | null,
  hydrated: true,
};

describe("authSlice", () => {
  it("stores access token + user on login; only persists user to localStorage", () => {
    const state = reducer(empty, loggedIn(payload));
    expect(state.accessToken).toBe("acc");
    expect(state.user?.username).toBe("alice");
    const persisted = JSON.parse(localStorage.getItem("peercast.auth")!);
    // Access token must NOT be in localStorage.
    expect(persisted.accessToken).toBeUndefined();
    expect(persisted.user.username).toBe("alice");
  });

  it("updates access token without dropping the user", () => {
    let state = reducer(empty, loggedIn(payload));
    state = reducer(state, tokensUpdated({ accessToken: "acc2" }));
    expect(state.accessToken).toBe("acc2");
    expect(state.user?.username).toBe("alice");
  });

  it("updates the cached user profile", () => {
    let state = reducer(empty, loggedIn(payload));
    state = reducer(state, userUpdated({ ...user, displayName: "Alice J" }));
    expect(state.user?.displayName).toBe("Alice J");
  });

  it("clears all state and localStorage on logout", () => {
    let state = reducer(empty, loggedIn(payload));
    state = reducer(state, loggedOut());
    expect(state.accessToken).toBeNull();
    expect(state.user).toBeNull();
    expect(state.hydrated).toBe(true);
    expect(localStorage.getItem("peercast.auth")).toBeNull();
  });

  it("setHydrated marks hydration complete without touching tokens", () => {
    const pre = { ...empty, hydrated: false };
    const state = reducer(pre, setHydrated());
    expect(state.hydrated).toBe(true);
    expect(state.accessToken).toBeNull();
  });
});
