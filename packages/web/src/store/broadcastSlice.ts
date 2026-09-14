import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { AccessPolicy } from "@peer-cast/shared";
import type { HostStats } from "../lib/peer";

// ─── Shapes ─────────────────────────────────────────────────────────────────

export interface ActiveBroadcast {
  broadcastId: string;
  title: string;
  access: AccessPolicy;
  /** Username of the broadcaster — used to construct the viewer URL. */
  viewerUsername: string;
}

export interface BroadcastState {
  /** UI / lifecycle status. */
  status: "idle" | "starting" | "live" | "ending";
  /** Present while a broadcast session is registered with the server. */
  active: ActiveBroadcast | null;
  /** Latest stats heartbeat; null when idle. */
  stats: HostStats | null;
}

// ─── Slice ───────────────────────────────────────────────────────────────────

const broadcastSlice = createSlice({
  name: "broadcast",
  initialState: {
    status: "idle",
    active: null,
    stats: null,
  } as BroadcastState,
  reducers: {
    broadcastStarting(state) {
      state.status = "starting";
      state.active = null;
      state.stats = null;
    },
    broadcastLive(state, action: PayloadAction<ActiveBroadcast>) {
      state.status = "live";
      state.active = action.payload;
    },
    broadcastEnding(state) {
      state.status = "ending";
    },
    broadcastStopped(state) {
      state.status = "idle";
      state.active = null;
      state.stats = null;
    },
    broadcastStatsUpdated(state, action: PayloadAction<HostStats>) {
      state.stats = action.payload;
    },
  },
});

export const {
  broadcastStarting,
  broadcastLive,
  broadcastEnding,
  broadcastStopped,
  broadcastStatsUpdated,
} = broadcastSlice.actions;

export default broadcastSlice.reducer;
