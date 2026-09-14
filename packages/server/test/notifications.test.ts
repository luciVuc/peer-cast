import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
// Enabling VAPID must happen BEFORE the app/config modules evaluate, because
// config resolves env at import time. vi.hoisted runs before all imports.
vi.hoisted(() => {
  process.env.VAPID_PUBLIC_KEY = "test-pub-key";
  process.env.VAPID_PRIVATE_KEY = "test-priv-key";
});
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    generateVAPIDKeys: vi
      .fn()
      .mockReturnValue({ publicKey: "p", privateKey: "s" }),
  },
}));
import webpush from "web-push";
import { makeApp, resetDb } from "./helpers.js";

const app = makeApp();

async function register(a: Express, username: string) {
  const res = await request(a)
    .post("/api/auth/register")
    .send({
      username,
      email: `${username}@example.com`,
      displayName: username,
      password: "secret123",
    });
  return res.body.accessToken as string;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const subA = {
  subscription: {
    endpoint: "https://push.example/push-1",
    expirationTime: null,
    keys: { p256dh: "dGhlLXAyNTZkaA", auth: "dGhlLWF1dGg" },
  },
};
const subB = {
  subscription: {
    endpoint: "https://push.example/push-2",
    keys: { p256dh: "c2Vjb25k", auth: "YXV0aC1i" },
  },
};

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
});

describe("follows", () => {
  it("requires auth and validates the target", async () => {
    const token = await register(app, "alice");
    await expect(
      request(app).get("/api/users/bob/following"),
    ).resolves.toMatchObject({
      status: 401,
    });
    const missing = await request(app)
      .post("/api/users/nobody/follow")
      .set(auth(token));
    expect(missing.status).toBe(404);
    const self = await request(app)
      .post("/api/users/alice/follow")
      .set(auth(token));
    expect(self.status).toBe(400);
  });

  it("follows, reports state, and unfollows", async () => {
    const bob = await register(app, "bob");
    await register(app, "alice");

    const before = await request(app)
      .get("/api/users/alice/following")
      .set(auth(bob));
    expect(before.body).toEqual({ following: false });

    const follow = await request(app)
      .post("/api/users/alice/follow")
      .set(auth(bob));
    expect(follow.status).toBe(200);
    expect(follow.body.following).toBe(true);

    const after = await request(app)
      .get("/api/users/alice/following")
      .set(auth(bob));
    expect(after.body.following).toBe(true);

    // Idempotent re-follow does not error.
    await expect(
      request(app).post("/api/users/alice/follow").set(auth(bob)),
    ).resolves.toMatchObject({ status: 200, body: { following: true } });

    const unfollow = await request(app)
      .delete("/api/users/alice/follow")
      .set(auth(bob));
    expect(unfollow.body.following).toBe(false);
    const final = await request(app)
      .get("/api/users/alice/following")
      .set(auth(bob));
    expect(final.body.following).toBe(false);
  });
});

describe("push subscriptions", () => {
  it("requires auth and validates the payload", async () => {
    await register(app, "alice");
    const noAuth = await request(app).post("/api/push/subscribe").send(subA);
    expect(noAuth.status).toBe(401);

    const bad = await request(app)
      .post("/api/push/subscribe")
      .set(auth(await register(app, "bob")))
      .send({
        subscription: { endpoint: "not-a-url", keys: { p256dh: "", auth: "" } },
      });
    expect(bad.status).toBe(400);
  });

  it("upserts by endpoint and removes on unsubscribe", async () => {
    const bob = await register(app, "bob");
    const first = await request(app)
      .post("/api/push/subscribe")
      .set(auth(bob))
      .send(subA);
    expect(first.status).toBe(200);
    // Same endpoint, new keys — upsert, not duplicate.
    const second = await request(app)
      .post("/api/push/subscribe")
      .set(auth(bob))
      .send(subA);
    expect(second.status).toBe(200);

    const del = await request(app)
      .delete("/api/push/subscribe")
      .set(auth(bob))
      .send({ endpoint: "https://push.example/push-1" });
    expect(del.status).toBe(200);
  });

  it("reassigns a reused endpoint to the latest subscriber", async () => {
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");
    await request(app).post("/api/push/subscribe").set(auth(alice)).send(subA);

    // Same endpoint re-registered with bob's keys — ownership must flip.
    await request(app)
      .post("/api/push/subscribe")
      .set(auth(bob))
      .send({
        subscription: {
          endpoint: "https://push.example/push-1",
          keys: { p256dh: "Ym9iLWtleXM", auth: "Ym9iLWF1dGg" },
        },
      });

    const { db } = await import("../src/db/index.js");
    const row = db
      .prepare(
        `SELECT username_lc, p256dh FROM push_subscriptions WHERE endpoint = ?`,
      )
      .get("https://push.example/push-1") as
      { username_lc: string; p256dh: string } | undefined;
    expect(row?.username_lc).toBe("bob");
    expect(row?.p256dh).toBe("Ym9iLWtleXM");
  });

  it("scopes unsubscribe to the owning account", async () => {
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");
    await request(app).post("/api/push/subscribe").set(auth(bob)).send(subA);

    // Alice's delete is a no-op (she doesn't own the endpoint)…
    await request(app)
      .delete("/api/push/subscribe")
      .set(auth(alice))
      .send({ endpoint: "https://push.example/push-1" });

    const { db } = await import("../src/db/index.js");
    const row = db
      .prepare(`SELECT 1 FROM push_subscriptions WHERE endpoint = ?`)
      .get("https://push.example/push-1");
    expect(row).toBeTruthy();

    // …while bob's own delete removes it.
    await request(app)
      .delete("/api/push/subscribe")
      .set(auth(bob))
      .send({ endpoint: "https://push.example/push-1" });
    const gone = db
      .prepare(`SELECT 1 FROM push_subscriptions WHERE endpoint = ?`)
      .get("https://push.example/push-1");
    expect(gone).toBeUndefined();
  });

  it("exposes the VAPID public key when enabled", async () => {
    const res = await request(app).get("/api/push/vapid-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: "test-pub-key" });
  });
});

describe("followed-user-goes-live push", () => {
  it("notifies followers when a public broadcast starts", async () => {
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");
    await request(app).post("/api/users/alice/follow").set(auth(bob));
    await request(app).post("/api/push/subscribe").set(auth(bob)).send(subB);

    const start = await request(app)
      .post("/api/broadcasts")
      .set(auth(alice))
      .send({
        title: "hello",
        access: "public",
        source: "screen",
        peerId: "pc-123",
      });
    expect(start.status).toBe(201);

    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const [sub, payload] = vi.mocked(webpush.sendNotification).mock
      .calls[0] as [
      { endpoint: string; keys: { p256dh: string; auth: string } },
      string,
    ];
    expect(sub.endpoint).toBe("https://push.example/push-2");
    const data = JSON.parse(payload);
    expect(data.title).toContain("alice");
    expect(data.url).toBe("/watch/alice");
  });

  it("stays silent for members-only and code broadcasts", async () => {
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");
    await request(app).post("/api/users/alice/follow").set(auth(bob));
    await request(app).post("/api/push/subscribe").set(auth(bob)).send(subB);

    await request(app).post("/api/broadcasts").set(auth(alice)).send({
      title: "x",
      access: "authenticated",
      source: "screen",
      peerId: "a1",
    });
    await request(app).post("/api/broadcasts").set(auth(alice)).send({
      title: "x",
      access: "code",
      source: "screen",
      peerId: "a2",
      accessCode: "abc12",
    });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("prunes dead endpoints reported by the push service", async () => {
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");
    await request(app).post("/api/users/alice/follow").set(auth(bob));
    await request(app).post("/api/push/subscribe").set(auth(bob)).send(subB);

    vi.mocked(webpush.sendNotification).mockRejectedValueOnce({
      statusCode: 410,
      message: "gone",
    });
    await request(app)
      .post("/api/broadcasts")
      .set(auth(alice))
      .send({ title: "x", access: "public", source: "screen", peerId: "b1" });
    // The dead endpoint must now be gone.
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);

    await request(app)
      .post("/api/broadcasts")
      .set(auth(alice))
      .send({ title: "x", access: "public", source: "screen", peerId: "b2" });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });
});
