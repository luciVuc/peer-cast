import { Router } from "express";
import { z } from "zod";
import type { ResolveResponse, VerifyTicketResponse } from "@peer-cast/shared";
import { issueTicket, verifyTicket } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { asyncHandler } from "../middleware/error.js";
import { optionalAuth } from "../middleware/auth.js";
import { broadcastsRepo, rowStatsOf } from "../repos/broadcasts.js";

export const sessionsRouter = Router();

/**
 * Resolve a broadcaster's current live session by @username.
 *
 * Access gates:
 *   public        → peerId revealed to anyone.
 *   authenticated → peerId only for logged-in viewers; ticket issued.
 *   code          → peerId only when a matching ?code= is supplied; ticket issued.
 *
 * The host (extension/web broadcaster) additionally verifies the ticket on
 * each incoming call for non-public broadcasts — resolving alone is not enough.
 */
sessionsRouter.get(
  "/:username",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const usernameLc = req.params.username.toLowerCase();
    const result = broadcastsRepo.liveForUserFull(usernameLc);
    if (!result) throw notFound("no live broadcast");
    const { row, live } = result;

    const base: Omit<ResolveResponse, "peerId" | "ticket"> = {
      broadcast: { ...live, peerId: null },
    };

    if (live.access === "public") {
      res.json({
        ...base,
        peerId: row.peer_id,
        ticket: null,
        stats: rowStatsOf(row),
      } as ResolveResponse);
      return;
    }

    if (live.access === "authenticated") {
      if (!req.auth) {
        res.status(401).json({ ...base, peerId: null, ticket: null });
        return;
      }
      const ticket = issueTicket(req.auth.usernameLc, row.peer_id!);
      res.json({
        ...base,
        peerId: row.peer_id,
        ticket,
        stats: rowStatsOf(row),
      } as ResolveResponse);
      return;
    }

    // access === "code"
    const code = String(req.query.code ?? "");
    if (!code || !broadcastsRepo.verifyAccessCode(row.id, code)) {
      res
        .status(code ? 403 : 401)
        .json({ ...base, peerId: null, ticket: null, needsCode: true });
      return;
    }
    const ticket = issueTicket(req.auth?.usernameLc ?? null, row.peer_id!);
    res.json({
      ...base,
      peerId: row.peer_id,
      ticket,
      stats: rowStatsOf(row),
    } as ResolveResponse);
  }),
);

const verifySchema = z.object({
  ticket: z.string().min(1),
  peerId: z.string().min(1),
});

sessionsRouter.post(
  "/verify-ticket",
  asyncHandler(async (req, res) => {
    const { ticket, peerId } = verifySchema.parse(req.body);
    const { ok, username } = verifyTicket(ticket, peerId);
    res.json({ ok, username } satisfies VerifyTicketResponse);
  }),
);
