import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { AuthResponse, SelfUser } from "@peer-cast/shared";

const STORAGE_KEY = "peercast.auth";

export interface AuthState {
  /** Short-lived access token; kept in Redux memory only (never persisted). */
  accessToken: string | null;
  /** Cached user profile — persisted to localStorage for page-reload detection. */
  user: SelfUser | null;
  /**
   * True once the startup refresh attempt has completed (or was skipped because
   * no user is cached). Routes check this before redirecting so they don't
   * bounce a returning user to /login before the cookie-based refresh finishes.
   */
  hydrated: boolean;
}

interface StoredAuth {
  /** Only non-sensitive profile data is persisted; no tokens. */
  user: SelfUser;
}

function load(): AuthState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredAuth;
      if (parsed.user) {
        // A previous session exists. Mark hydrated:false so main.tsx will
        // call /auth/refresh before mounting React to restore the access token.
        return { accessToken: null, user: parsed.user, hydrated: false };
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { accessToken: null, user: null, hydrated: true };
}

function persist(state: AuthState) {
  if (state.user) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ user: state.user } satisfies StoredAuth),
    );
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

const authSlice = createSlice({
  name: "auth",
  initialState: load(),
  reducers: {
    /** Called after a successful login or register. */
    loggedIn(state, action: PayloadAction<AuthResponse>) {
      state.accessToken = action.payload.accessToken;
      state.user = action.payload.user;
      state.hydrated = true;
      persist(state);
    },
    /** Called after a successful token refresh (access token only). */
    tokensUpdated(state, action: PayloadAction<{ accessToken: string }>) {
      state.accessToken = action.payload.accessToken;
      state.hydrated = true;
      // user unchanged; localStorage unchanged
    },
    /** Called when profile data changes. */
    userUpdated(state, action: PayloadAction<SelfUser>) {
      state.user = action.payload;
      persist(state);
    },
    /** Clear all auth state (logout, expired refresh, etc.). */
    loggedOut(state) {
      state.accessToken = null;
      state.user = null;
      state.hydrated = true;
      persist(state);
    },
    /** Mark hydration complete without updating tokens (no session to restore). */
    setHydrated(state) {
      state.hydrated = true;
    },
  },
});

export const { loggedIn, tokensUpdated, userUpdated, loggedOut, setHydrated } =
  authSlice.actions;
export default authSlice.reducer;
