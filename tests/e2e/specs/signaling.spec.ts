import { expect, test } from "@playwright/test";
import { peerjsUrl } from "./helpers.js";

/**
 * Proves the self-hosted PeerJS signaling server brokers a real WebRTC media
 * session: a host peer answers a viewer peer's call and the viewer receives a
 * live video track — all through `/peerjs`, no external services.
 */
test("WebRTC media flows viewer↔host over self-hosted signaling", async ({
  page,
}) => {
  await page.goto("/");
  await page.addScriptTag({ url: peerjsUrl });

  const result = await page.evaluate(async () => {
    const Peer = (window as unknown as { Peer: new (...a: unknown[]) => any })
      .Peer;
    const opts = {
      host: location.hostname,
      port: Number(location.port),
      path: "/peerjs",
      key: "peercast",
      secure: false,
    };

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    canvas.getContext("2d")!.fillRect(0, 0, 64, 64);
    const hostStream = (
      canvas as HTMLCanvasElement & {
        captureStream(fps?: number): MediaStream;
      }
    ).captureStream(5);

    const hostId = "e2e-host-" + Math.random().toString(36).slice(2, 8);
    const host = new Peer(hostId, opts);
    await new Promise((res, rej) => {
      host.on("open", res);
      host.on("error", rej);
      setTimeout(() => rej(new Error("host open timeout")), 8000);
    });
    host.on("call", (call: any) => call.answer(hostStream));

    const viewer = new Peer(opts);
    const viewerId = await new Promise((res, rej) => {
      viewer.on("open", res);
      viewer.on("error", rej);
      setTimeout(() => rej(new Error("viewer open timeout")), 8000);
    });

    const dummy = (
      document.createElement("canvas") as HTMLCanvasElement & {
        captureStream(fps?: number): MediaStream;
      }
    ).captureStream(1);

    const remote: MediaStream = await new Promise((res, rej) => {
      const call = viewer.call(hostId, dummy, { metadata: { ticket: null } });
      call.on("stream", res);
      call.on("error", rej);
      setTimeout(() => rej(new Error("no stream in 10s")), 10000);
    });

    const track = remote.getVideoTracks()[0];
    const out = {
      hostId,
      viewerId,
      videoTracks: remote.getVideoTracks().length,
      trackState: track?.readyState,
    };
    host.destroy();
    viewer.destroy();
    return out;
  });

  expect(result.videoTracks).toBeGreaterThan(0);
  expect(result.trackState).toBe("live");
  expect(result.viewerId).toBeTruthy();
});
