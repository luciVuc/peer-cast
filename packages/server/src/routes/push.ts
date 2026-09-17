import { Router } from "express";
import { z } from "zod";
import type {
  PushSubscribeRequest,
  PushVapidKeyResponse,
} from "@peer-cast/shared";
import { badRequest } from "../lib/errors.js";
import {
  getVapidPublicKey,
  isAllowedPushEndpoint,
  vapidEnabled,
} from "../lib/push.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  removeOwnedSubscription,
  saveSubscription,
} from "../repos/notifications.js";

export const pushRouter = Router();

// ─── Public VAPID key (404 when push is not configured) ─────────────────────

pushRouter.get("/vapid-key", (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    res
      .status(404)
      .json({ error: "push notifications are disabled on this server" });
    return;
  }
  res.json({ publicKey: key } satisfies PushVapidKeyResponse);
});

// ─── Subscribe / unsubscribe (authed) ───────────────────────────────────────

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    expirationTime: z.number().int().nullish(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
});

pushRouter.post(
  "/subscribe",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!vapidEnabled()) throw badRequest("push notifications are disabled");
    const body = subscribeSchema.parse(req.body) as PushSubscribeRequest;
    if (!isAllowedPushEndpoint(body.subscription.endpoint)) {
      throw badRequest("unsupported push service endpoint", "PUSH_ENDPOINT");
    }
    saveSubscription(req.auth!.usernameLc, {
      endpoint: body.subscription.endpoint,
      p256dh: body.subscription.keys.p256dh,
      auth: body.subscription.keys.auth,
    });
    res.json({ ok: true });
  }),
);

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

pushRouter.delete(
  "/subscribe",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = unsubscribeSchema.parse(req.body);
    removeOwnedSubscription(body.endpoint, req.auth!.usernameLc);
    res.json({ ok: true });
  }),
);
