import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ViewerPage } from "./ViewerPage";

/**
 * Regression coverage for the reconnect loop.
 *
 * Bug: when a stream dropped and the host had not started the next broadcast
 * yet, the retry poll returned 404 and the viewer set phase "offline" without
 * scheduling another attempt — stranding the viewer on the "isn't live" screen
 * until they clicked Retry by hand, even once the host was broadcasting again.
 *
 * The page wires its behavior through RTK Query + the PeerJS wrapper, both of
 * which are mocked here so we can flip host state and assert on the UI.
 */

const trigger = vi.fn();
const connectAsViewer = vi.fn();

/**
 * Stable reference: the page's mount effect keys on `cfg`, so an inline object
 * literal here would re-fire the effect on every render (the real RTK Query
 * hook returns the same cached object between renders).
 */
const cfg = {
  signaling: { host: "h", port: 1, secure: false, path: "/p", key: "k" },
};

vi.mock("../store/api", () => ({
  useGetConfigQuery: () => ({ data: cfg }),
  useLazyResolveSessionQuery: () => [trigger, { data: undefined }],
  useSignalingTicketMutation: () => [
    vi.fn().mockResolvedValue({ token: "sig" }),
  ],
  useListLiveQuery: () => ({ data: undefined }),
  useCreateReportMutation: () => [vi.fn()],
  useFollowUserMutation: () => [vi.fn()],
  useUnfollowUserMutation: () => [vi.fn()],
  useGetUserFollowingQuery: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("../store", () => ({
  useAppSelector: (sel: (s: unknown) => unknown) =>
    sel({ auth: { accessToken: null, user: null } }),
}));

vi.mock("../lib/peer", () => ({
  connectAsViewer: (...args: unknown[]) => connectAsViewer(...args),
  packChat: (from: string, text: string) => ({ id: "m1", from, text, at: 1 }),
}));

/** Handle returned by the mocked connectAsViewer; lets tests fire callbacks. */
type Handle = {
  onStream: (s: MediaStream) => void;
  onClose: () => void;
  close: () => void;
};
let handle: Handle;

/** Mirrors whether the host currently has a live broadcast. */
let hostLive = false;

/** The live payload RTK Query hands back once the host is broadcasting. */
const liveResult = {
  data: {
    peerId: "peer-1",
    ticket: "t",
    needsCode: false,
    broadcast: {
      id: "b1",
      title: "Hello",
      owner: { username: "alice", displayName: "Alice" },
    },
    stats: null,
  },
};

function renderViewer() {
  return render(
    <MemoryRouter initialEntries={["/watch/alice"]}>
      <Routes>
        <Route path="/watch/:username" element={<ViewerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Flush the microtask queue so the resolve() continuation runs. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** jsdom has neither MediaStream nor a working HTMLMediaElement.play(). */
const fakeStream = {} as MediaStream;

describe("ViewerPage reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hostLive = false;
    trigger.mockReset();
    connectAsViewer.mockReset();
    HTMLMediaElement.prototype.play = vi
      .fn()
      .mockResolvedValue(
        undefined,
      ) as unknown as typeof HTMLMediaElement.prototype.play;
    // Answer from host state rather than a call queue, so assertions don't
    // depend on how many polls the backoff decides to make.
    trigger.mockImplementation(async () =>
      hostLive ? liveResult : { error: { status: 404 } },
    );
    connectAsViewer.mockImplementation(
      (opts: { onStream: Handle["onStream"]; onClose: Handle["onClose"] }) => {
        handle = {
          onStream: opts.onStream,
          onClose: opts.onClose,
          close: vi.fn(),
        };
        return handle;
      },
    );
  });

  it("keeps polling after the host goes offline mid-watch and reconnects when it returns", async () => {
    hostLive = true;
    renderViewer();
    await settle();

    act(() => handle.onStream(fakeStream));
    expect(screen.getByText("LIVE")).toBeInTheDocument();

    // Host ends the broadcast: connection drops, then host goes offline.
    act(() => handle.onClose());
    hostLive = false;

    // First backoff poll (3 s) lands during the gap -> 404.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText(/isn't live/)).toBeInTheDocument();

    // The bug lived here: the 404 left no retry armed, so no further poll was
    // ever made. Host comes back — we must find it with no user action.
    hostLive = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(connectAsViewer).toHaveBeenCalledTimes(2);

    act(() => handle.onStream(fakeStream));
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.queryByText(/isn't live/)).not.toBeInTheDocument();
  });

  it("stops auto-polling once the retry window is spent, leaving Retry to the user", async () => {
    hostLive = true;
    renderViewer();
    await settle();
    act(() => handle.onStream(fakeStream));

    // Stream drops and the host never comes back.
    act(() => handle.onClose());
    hostLive = false;

    // Poll until well past the retry window (attempts run at 3/6/12/24 s then
    // every 30 s, and stop once the window closes).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    const callsAtWindowEnd = trigger.mock.calls.length;
    // ~13 attempts with a 30 s floor — nowhere near the 120/15 min budget that
    // `/api/sessions` enforces.
    expect(callsAtWindowEnd).toBeLessThan(20);

    // No further polling, ever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(trigger.mock.calls.length).toBe(callsAtWindowEnd);
    expect(screen.getByText(/isn't live/)).toBeInTheDocument();

    // The user can still restart the loop by hand.
    hostLive = true;
    act(() => screen.getByRole("button", { name: "Retry" }).click());
    await settle();
    expect(connectAsViewer).toHaveBeenCalledTimes(2);
  });

  it("offers Retry — not a dead spinner — when a long watch drops after the window", async () => {
    hostLive = true;
    renderViewer();
    await settle();
    act(() => handle.onStream(fakeStream));
    expect(screen.getByText("LIVE")).toBeInTheDocument();

    // Watch for longer than RETRY_WINDOW_MS. onStream refreshes the retry
    // deadline, so the window is measured from the last frame received — this
    // is the ordinary case for any real viewer, not an edge case.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
    });
    expect(screen.getByText("LIVE")).toBeInTheDocument();

    // Now the host's network blips. The window is already spent.
    hostLive = false;
    act(() => handle.onClose());

    // Regression: onClose sets phase "resolving" *before* calling
    // scheduleReconnect(), so a silent no-op there left the viewer on a
    // permanent "Finding broadcast…" spinner with no Retry button — the only
    // escape was a full page reload.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByText("Finding broadcast…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    // And the button actually works: a manual Retry re-arms the full window.
    hostLive = true;
    act(() => screen.getByRole("button", { name: "Retry" }).click());
    await settle();
    expect(connectAsViewer).toHaveBeenCalledTimes(2);
  });

  it("does not poll in the background for a host that was never live", async () => {
    renderViewer();
    await settle();

    expect(screen.getByText(/isn't live/)).toBeInTheDocument();
    expect(connectAsViewer).not.toHaveBeenCalled();

    // No background polling: even far past the 30 s cap, still one attempt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});
