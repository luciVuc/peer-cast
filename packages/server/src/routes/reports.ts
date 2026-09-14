import { Router } from "express";
import { z } from "zod";
import type { Report } from "@peer-cast/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { asyncHandler } from "../middleware/error.js";
import { optionalAuth } from "../middleware/auth.js";
import { usersRepo } from "../repos/users.js";
import { reportsRepo } from "../repos/reports.js";

export const reportsRouter = Router();

const reportSchema = z.object({
  targetUsername: z.string().min(1).max(30),
  broadcastId: z.string().max(64).nullish(),
  reason: z.string().trim().min(3).max(500),
});

/**
 * File an abuse report against a user/broadcast. Anyone may report (auth is
 * optional); the reporter handle is recorded when signed in.
 */
reportsRouter.post(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const body = reportSchema.parse(req.body);
    const targetLc = body.targetUsername.toLowerCase();
    if (!usersRepo.getPublic(targetLc)) throw notFound("user not found");
    if (req.auth && req.auth.usernameLc === targetLc) {
      throw badRequest("you cannot report yourself");
    }
    const report: Report = reportsRepo.create({
      targetUsernameLc: targetLc,
      broadcastId: body.broadcastId ?? null,
      reporterUsernameLc: req.auth?.usernameLc ?? null,
      reason: body.reason,
    });
    res.status(201).json({ ok: true, report });
  }),
);
