import { Router } from "express";
import { z } from "zod";
import { TITLE_MAX, ACCESS_CODE_MIN } from "@peer-cast/shared";
import type {
  ListBroadcastsResponse,
  StartBroadcastResponse,
} from "@peer-cast/shared";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { broadcastsRepo } from "../repos/broadcasts.js";
import { notifyFollowersLive } from "../lib/push.js";

export const broadcastsRouter = Router();

// ─── Public: currently live broadcasts (landing page feed) ──────────────────

broadcastsRouter.get(
  "/live",
  asyncHandler(async (_req, res) => {
    res.json({
      broadcasts: broadcastsRepo.listLive(),
    } satisfies ListBroadcastsResponse);
  }),
);

// ─── Broadcaster: my broadcast history ──────────────────────────────────────

broadcastsRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({
      broadcasts: broadcastsRepo.historyForUser(req.auth!.usernameLc),
    } satisfies ListBroadcastsResponse);
  }),
);

// ─── Start a broadcast (from web broadcaster page or the extension) ─────────

const startSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  description: z.string().max(1000).nullish(),
  access: z.enum(["public", "authenticated", "code"]),
  source: z.enum(["tab", "screen", "window", "camera"]),
  peerId: z.string().min(1).max(200),
  accessCode: z
    .string()
    .min(
      ACCESS_CODE_MIN,
      `access code must be at least ${ACCESS_CODE_MIN} characters`,
    )
    .max(64)
    .optional(),
});

broadcastsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = startSchema.parse(req.body);
    if (body.access === "code" && !body.accessCode) {
      throw badRequest("accessCode is required when access is 'code'");
    }
    const broadcast = broadcastsRepo.start({
      usernameLc: req.auth!.usernameLc,
      title: body.title,
      description: body.description?.trim() ?? null,
      access: body.access,
      source: body.source,
      peerId: body.peerId,
      accessCode: body.accessCode ?? null,
    });
    // Fire-and-forget: tell opted-in followers this broadcaster went live.
    // Only for public broadcasts — a members-only/code stream stays quiet so
    // we never leak a signal that a restricted broadcast has started.
    if (body.access === "public") {
      notifyFollowersLive(req.auth!.usernameLc).catch(() => {
        /* push is best-effort; never fail the start on a push error */
      });
    }
    res.status(201).json({ broadcast } satisfies StartBroadcastResponse);
  }),
);

// ─── Live stats heartbeat ────────────────────────────────────────────────

const statsSchema = z.object({
  stats: z.object({
    viewers: z.number().int().min(0),
    bitrateKbps: z.number().nullable(),
    fps: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    totalConnections: z.number().int().min(0).optional(),
  }),
});

broadcastsRouter.post(
  "/:id/stats",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = statsSchema.parse(req.body);
    const updated = broadcastsRepo.updateStats(
      req.params.id,
      req.auth!.usernameLc,
      body.stats,
    );
    if (!updated) throw notFound("live broadcast not found");
    res.json({ broadcast: updated });
  }),
);

// ─── End a broadcast ────────────────────────────────────────────────────

broadcastsRouter.post(
  "/:id/end",
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = broadcastsRepo.get(req.params.id);
    if (!existing) throw notFound("broadcast not found");
    const ended = broadcastsRepo.end(req.params.id, req.auth!.usernameLc);
    if (!ended) throw forbidden("not your broadcast");
    res.json({ broadcast: ended });
  }),
);

// ─── Single broadcast detail ─────────────────────────────────────────────

broadcastsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = broadcastsRepo.getWithUser(req.params.id);
    if (!b) throw notFound("broadcast not found");
    // Never leak peerId here; resolving is done via /sessions with access checks.
    res.json({ broadcast: { ...b, peerId: null } });
  }),
);
