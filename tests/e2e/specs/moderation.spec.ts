import { expect, test } from "@playwright/test";
import { peerjsUrl, uniqueUsername } from "./helpers.js";

async function registerToken(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
  username: string,
) {
  const res = await request.post(`${baseURL}/api/auth/register`, {
    data: {
      username,
      email: `${username}@example.com`,
      displayName: username,
      password: "secret123",
    },
  });
  return (await res.json()).accessToken as string;
}

/**
 * Proves auth-gated signaling: a banned account's valid JWT is evicted at the
 * PeerJS handshake, while the same token opens fine before the ban.
 */
test("banned accounts are evicted at the signaling handshake", async ({
  page,
  request,
  baseURL,
}) => {
  const base = baseURL!;
  // Bootstrap an admin (ADMIN_USERNAMES=admin) + a victim.
  const adminToken = await registerToken(request, base, "admin");
  const victim = uniqueUsername("victim");
  const victimToken = await registerToken(request, base, victim);

  await page.goto("/");
  await page.addScriptTag({ url: peerjsUrl });

  const opensWithToken = (token: string) =>
    page.evaluate(
      async ({ token, id }) => {
        const Peer = (
          window as unknown as { Peer: new (...a: unknown[]) => any }
        ).Peer;
        const peer = new Peer(id, {
          host: location.hostname,
          port: Number(location.port),
          path: "/peerjs",
          key: "peercast",
          secure: false,
          token,
        });
        // Did the signaling server ever send us OPEN? A banned account is
        // evicted at the handshake, so OPEN never arrives.
        return await new Promise<boolean>((resolve) => {
          let opened = false;
          peer.on("open", () => {
            opened = true;
          });
          setTimeout(() => {
            try {
              peer.destroy();
            } catch {
              /* noop */
            }
            resolve(opened);
          }, 5000);
        });
      },
      { token, id: "pc-" + Math.random().toString(36).slice(2, 10) },
    );

  // Before ban: the victim's token opens a signaling connection.
  expect(await opensWithToken(victimToken)).toBe(true);

  // Admin bans the victim.
  const ban = await request.post(`${base}/api/admin/users/${victim}/ban`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { reason: "e2e" },
  });
  expect(ban.ok()).toBeTruthy();

  // After ban: the same token is evicted (socket closed → OPEN never arrives).
  expect(await opensWithToken(victimToken)).toBe(false);
});
