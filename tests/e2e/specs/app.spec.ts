import { expect, test, type Page } from "@playwright/test";
import { peerjsUrl, uniqueUsername } from "./helpers.js";

async function register(page: Page, username: string) {
  await page.goto("/register");
  await page.locator("#reg-displayName").fill("E2E User");
  await page.locator("#reg-username").fill(username);
  await page.locator("#reg-email").fill(`${username}@example.com`);
  await page.locator("#reg-password").fill("secret123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test("landing page loads with hero + live section", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Broadcast your screen/i }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Live now" })).toBeVisible();
});

test("register → discover live broadcast → watch it play", async ({
  page,
  context,
  baseURL,
}) => {
  const username = uniqueUsername();
  await register(page, username);

  // Access tokens never touch localStorage (they live in memory + httpOnly
  // cookie), so mint a fresh one via the API the broadcaster would call.
  const { accessToken: token } = (await (
    await context.request.post(`${baseURL}/api/auth/login`, {
      data: { username, password: "secret123" },
    })
  ).json()) as { accessToken: string };
  const peerId = `e2e-live-${username}`;

  // Announce a public broadcast via the API (as the extension/web host would).
  const res = await context.request.post(`${baseURL}/api/broadcasts`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: "E2E Live Session",
      access: "public",
      source: "screen",
      peerId,
    },
  });
  expect(res.ok()).toBeTruthy();

  // Landing page now surfaces the broadcast in the live feed + search.
  await page.goto("/");
  await expect(page.getByText("E2E Live Session")).toBeVisible();
  await page.goto(`/?q=${username}`);
  await expect(page.getByText("E2E Live Session")).toBeVisible();

  // Spin up a real PeerJS host bound to the announced peerId in a second page.
  const host = await context.newPage();
  await host.goto("/");
  await host.addScriptTag({ url: peerjsUrl });
  await host.evaluate(async (id) => {
    const Peer = (window as unknown as { Peer: new (...a: unknown[]) => any })
      .Peer;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0ea5e9";
    ctx.fillRect(0, 0, 128, 128);
    const stream = (
      canvas as HTMLCanvasElement & {
        captureStream(fps?: number): MediaStream;
      }
    ).captureStream(10);
    const peer = new Peer(id, {
      host: location.hostname,
      port: Number(location.port),
      path: "/peerjs",
      key: "peercast",
      secure: false,
    });
    (window as unknown as { __peer: unknown }).__peer = peer; // keep alive
    await new Promise((resolve, reject) => {
      peer.on("open", resolve);
      peer.on("error", reject);
      setTimeout(() => reject(new Error("host open timeout")), 8000);
    });
    peer.on("call", (call: any) => call.answer(stream));
  }, peerId);

  // The viewer page resolves the session, dials the host over the self-hosted
  // signaling server, and receives the live media stream.
  await page.goto(`/watch/${username}`);
  await expect(page.getByText("E2E Live Session")).toBeVisible();

  // The <video> receives a live MediaStream with a video track. (In headless
  // Chromium the cross-process ICE session may drop right after connecting, so
  // we assert on stream *arrival* — the end-to-end P2P media path — rather than
  // on a persistent connection.)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const v = document.querySelector("video") as HTMLVideoElement | null;
          const s = v?.srcObject as MediaStream | null;
          return s ? s.getVideoTracks().length : 0;
        }),
      { timeout: 20_000, message: "viewer never received a video track" },
    )
    .toBeGreaterThan(0);

  await host.close();
});

test("watching an offline user shows the illustrated 'not live' message", async ({
  page,
}) => {
  await page.goto("/watch/definitelynotlive");
  await expect(page.getByText(/isn't live/i)).toBeVisible();
});
