/**
 * Module-level singleton that holds the non-serializable broadcast objects
 * (BroadcastHost, MediaStream).  These cannot live in Redux, but they need to
 * survive React component unmounts when the user navigates away from
 * /broadcast.  Any component can read them here; only BroadcastPage writes.
 */

import type { BroadcastHost } from "./peer";

interface ServiceState {
  host: BroadcastHost | null;
  stream: MediaStream | null;
}

const _state: ServiceState = { host: null, stream: null };

export const broadcastService = {
  get host(): BroadcastHost | null {
    return _state.host;
  },
  get stream(): MediaStream | null {
    return _state.stream;
  },

  setHost(h: BroadcastHost | null): void {
    _state.host = h;
  },
  setStream(s: MediaStream | null): void {
    _state.stream = s;
  },

  /** Stop the host, release all media tracks, and reset pointers. */
  cleanup(): void {
    _state.host?.stop();
    _state.host = null;
    _state.stream?.getTracks().forEach((t) => t.stop());
    _state.stream = null;
  },
};
