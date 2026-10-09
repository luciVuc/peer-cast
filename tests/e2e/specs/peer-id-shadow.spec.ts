import { expect, test } from "@playwright/test";
import { peerjsUrl } from "./helpers.js";

/**
 * Pins the peer-id uniqueness guarantee on the signaling server.
 *
 * A peer id is the routing address: whichever socket is registered as "abc"
 * receives calls addressed to "abc". So if a second socket could register an id
 * already held by a live broadcaster, it would shadow that broadcaster's
 * inbound media calls — and peer ids are not secret (they are handed to every
 * admitted viewer by /api/sessions and land in reverse-proxy access logs).
 *
 * An earlier review of this repo claimed that was possible and proposed a
 * home-grown id-binding layer. It is not possible: the `peer` package calls
 * `getClientById` on every registration and answers ID-TAKEN unless the socket
 * presents the *same* per-client token, which only the incumbent holds. This
 * test exists to keep that assumption honest — if a PeerJS upgrade or a config
 * change removes the check, this fails instead of the property silently
 * regressing.
 */
test("a peer id already held cannot be registered by a second client", async ({
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
    const sharedId = "e2e-shadow-" + Math.random().toString(36).slice(2, 8);

    const waitOpen = (p: any, ms = 8000) =>
      new Promise<void>((res, rej) => {
        p.on("open", () => res());
        p.on("error", (e: Error) => rej(e));
        setTimeout(() => rej(new Error("open timeout")), ms);
      });

    // A dummy stream so the incumbent can answer a call with media.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    canvas.getContext("2d")!.fillRect(0, 0, 64, 64);
    const stream = (
      canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }
    ).captureStream(5);

    // First socket legitimately claims the id and registers a call handler.
    const first = new Peer(sharedId, opts);
    await waitOpen(first);
    first.on("call", (call: any) => call.answer(stream));

    // Second, unrelated client attempts to claim the same id.
    const second = new Peer(sharedId, opts);
    const outcome = await Promise.race([
      new Promise<string>((res) => second.on("open", () => res("opened"))),
      new Promise<string>((res) =>
        second.on("error", (e: Error) => res(e.type || e.message)),
      ),
      new Promise<string>((res) =>
        setTimeout(() => res("timeout-accepted"), 6000),
      ),
    ]);

    // The incumbent must still be the reachable peer at that id. Only it can
    // answer, so receiving a video track proves the attempt did not displace it.
    let incumbentStillAnswers = false;
    let probeErr = "";
    try {
      const caller = new Peer(undefined, opts);
      await waitOpen(caller);
      const call = caller.call(sharedId, stream);
      incumbentStillAnswers = await new Promise<boolean>((res) => {
        const t = setTimeout(() => res(false), 10000);
        call.on("stream", () => {
          clearTimeout(t);
          res(true);
        });
        call.on("error", (e: Error) => {
          probeErr = e.message || e.type;
          clearTimeout(t);
          res(false);
        });
      });
      caller.destroy();
    } catch (e) {
      probeErr = String(e);
    }

    try {
      second.destroy();
    } catch {
      /* noop */
    }
    try {
      first.destroy();
    } catch {
      /* noop */
    }
    return { outcome, incumbentStillAnswers, probeErr };
  });

  // The duplicate registration is refused, not silently accepted.
  expect(result.outcome).toBe("unavailable-id");
  // And the incumbent is untouched — still the one reachable at that id.
  expect(result.incumbentStillAnswers, `probe failed: ${result.probeErr}`).toBe(
    true,
  );
});
