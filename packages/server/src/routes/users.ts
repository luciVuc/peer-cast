import { Router } from "express";
import { z } from "zod";
import { ABOUT_MAX, DISPLAY_NAME_MAX, PASSWORD_MIN } from "@peer-cast/shared";
import type {
  SearchResponse,
  SelfProfileResponse,
  UserProfileResponse,
} from "@peer-cast/shared";
import {
  hashPassword,
  verifyPassword,
  revokeAllRefreshTokens,
} from "../lib/auth.js";
import { saveAvatar, deleteAvatar } from "../lib/avatar.js";
import { badRequest, notFound, unauthorized } from "../lib/errors.js";
import { asyncHandler } from "../middleware/error.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { usersRepo } from "../repos/users.js";
import { broadcastsRepo } from "../repos/broadcasts.js";
import notificationsRepo from "../repos/notifications.js";
import recordingsRepo from "../repos/recordings.js";

export const usersRouter = Router();

const MAX_AVATAR_BYTES = 200 * 1024;

// Raster-only allowlist. SVGs are excluded (they can carry <script>/external
// references that age into XSS once served from a shared origin), and the
// `+xml` variants of the allowed types would sidestep the intent.
const RASTER_DATA_URL_RE =
  /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

// ─── Directory search (users + live broadcasts) ─────────────────────────────

usersRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.json({ users: [], broadcasts: [] } satisfies SearchResponse);
      return;
    }
    const out: SearchResponse = {
      users: usersRepo.search(q),
      broadcasts: broadcastsRepo.searchLive(q),
    };
    res.json(out);
  }),
);

// ─── Own profile + settings ──────────────────────────────────────────────

usersRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const self = usersRepo.getSelf(req.auth!.usernameLc);
    if (!self) throw notFound("user not found");
    res.json(self satisfies SelfProfileResponse);
  }),
);

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX).optional(),
  about: z.string().max(ABOUT_MAX).nullish(),
  avatarDataUrl: z.string().nullish(),
});

usersRouter.put(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = profileSchema.parse(req.body);
    const patch: Parameters<typeof usersRepo.updateProfile>[1] = {};

    // Avatar: save file to disk (not inline in DB) or delete.
    if (typeof body.avatarDataUrl === "string") {
      if (
        !RASTER_DATA_URL_RE.test(body.avatarDataUrl) ||
        body.avatarDataUrl.length > MAX_AVATAR_BYTES
      ) {
        throw badRequest(
          "avatar must be a raster image (PNG/JPEG/WebP/GIF) as a data URL ≤ 200 KB",
        );
      }
      patch.avatarUrl = saveAvatar(req.auth!.usernameLc, body.avatarDataUrl);
    } else if (body.avatarDataUrl === null) {
      deleteAvatar(req.auth!.usernameLc);
      patch.avatarUrl = null;
    }

    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.about !== undefined) patch.about = body.about?.trim() ?? null;

    const user = usersRepo.updateProfile(req.auth!.usernameLc, patch);
    res.json({ user });
  }),
);

const settingsSchema = z.object({
  defaultAccess: z.enum(["public", "authenticated", "code"]).optional(),
  defaultTitle: z.string().trim().min(1).max(120).optional(),
  discoverable: z.boolean().optional(),
});

usersRouter.put(
  "/me/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = settingsSchema.parse(req.body);
    const settings = usersRepo.updateSettings(req.auth!.usernameLc, body);
    res.json({ settings });
  }),
);

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN),
});

usersRouter.put(
  "/me/password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = passwordSchema.parse(req.body);
    const raw = usersRepo.getRaw(req.auth!.usernameLc);
    if (!raw) throw notFound("user not found");
    const ok = await verifyPassword(body.currentPassword, raw.password_hash);
    if (!ok)
      throw unauthorized("current password is incorrect", "BAD_PASSWORD");
    usersRepo.setPassword(
      req.auth!.usernameLc,
      await hashPassword(body.newPassword),
    );
    // Invalidate every outstanding session: refresh tokens (both JWTs and the
    // refresh cookie) AND access JWTs via the token-version bump. Without the
    // bump a stolen access token stays valid for the 15-minute TTL after the
    // owner recovers the account.
    usersRepo.bumpTokenVersion(req.auth!.usernameLc);
    revokeAllRefreshTokens(req.auth!.usernameLc);
    res.json({ ok: true });
  }),
);

// ─── Account self-deletion (right to erasure) ─────────────────────────────────

const deleteAccountSchema = z.object({
  password: z.string().min(1),
});

usersRouter.delete(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { password } = deleteAccountSchema.parse(req.body);
    const raw = usersRepo.getRaw(req.auth!.usernameLc);
    if (!raw) throw notFound("user not found");
    const ok = await verifyPassword(password, raw.password_hash);
    if (!ok) throw unauthorized("password is incorrect", "BAD_PASSWORD");
    // End any live broadcast and revoke all sessions before deletion.
    const { broadcastsRepo } = await import("../repos/broadcasts.js");
    broadcastsRepo.endAllForUser(req.auth!.usernameLc);
    revokeAllRefreshTokens(req.auth!.usernameLc);
    recordingsRepo.deleteAllForUser(req.auth!.usernameLc);
    usersRepo.delete(req.auth!.usernameLc);
    res.json({ ok: true });
  }),
);

// ─── Public profile by @username (+ live status) ────────────────────────────

usersRouter.get(
  "/:username",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const usernameLc = req.params.username.toLowerCase();
    const user = usersRepo.getPublic(usernameLc);
    if (!user) throw notFound("user not found");
    const live = broadcastsRepo.liveWithUser(usernameLc);
    const out: UserProfileResponse = {
      user,
      // Hide the peerId here; resolving happens via /sessions to enforce access.
      live: live ? { ...live, peerId: null } : null,
    };
    res.json(out);
  }),
);

// ─── Public broadcast history (for user profile page) ──────────────────────
usersRouter.get(
  "/:username/broadcasts",
  asyncHandler(async (req, res) => {
    const usernameLc = req.params.username.toLowerCase();
    const user = usersRepo.getRaw(usernameLc);
    if (!user || !user.discoverable || user.banned)
      throw notFound("user not found");
    const cursor = Number(req.query.cursor) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const { rows, nextCursor } = broadcastsRepo.publicHistoryForUser(
      usernameLc,
      cursor,
      limit,
    );
    res.json({ broadcasts: rows, nextCursor, limit });
  }),
);

// ─── Follows (drive "followed user goes live" push notifications) ───────────

usersRouter.get(
  "/:username/following",
  requireAuth,
  asyncHandler(async (req, res) => {
    const usernameLc = req.params.username.toLowerCase();
    const target = usersRepo.getRaw(usernameLc);
    if (!target) throw notFound("user not found");
    res.json({
      following: notificationsRepo.isFollowing(
        req.auth!.usernameLc,
        usernameLc,
      ),
    });
  }),
);

usersRouter.post(
  "/:username/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const usernameLc = req.params.username.toLowerCase();
    if (usernameLc === req.auth!.usernameLc) {
      throw badRequest("you cannot follow yourself");
    }
    const target = usersRepo.getRaw(usernameLc);
    if (!target) throw notFound("user not found");
    notificationsRepo.follow(req.auth!.usernameLc, usernameLc);
    res.json({ ok: true, following: true });
  }),
);

usersRouter.delete(
  "/:username/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const usernameLc = req.params.username.toLowerCase();
    notificationsRepo.unfollow(req.auth!.usernameLc, usernameLc);
    res.json({ ok: true, following: false });
  }),
);
