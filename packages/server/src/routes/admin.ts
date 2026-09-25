import { Router } from "express";
import { z } from "zod";
import type {
  AdminMetricsResponse,
  AdminReportsResponse,
  AdminUsersResponse,
} from "@peer-cast/shared";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { revokeAllRefreshTokens } from "../lib/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { usersRepo } from "../repos/users.js";
import { broadcastsRepo } from "../repos/broadcasts.js";
import { reportsRepo } from "../repos/reports.js";
import { invitesRepo } from "../repos/invites.js";
import { metricsRepo } from "../repos/metrics.js";
import recordingsRepo from "../repos/recordings.js";
import { auditRepo } from "../repos/audit.js";

export const adminRouter = Router();

// Every admin route requires an authenticated admin.
adminRouter.use(requireAuth, requireAdmin);

const isLive = (usernameLc: string) => !!broadcastsRepo.liveForUser(usernameLc);

// ─── Users ─────────────────────────────────────────────────────────────

adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "");
    res.json({
      users: usersRepo.listForAdmin(q, isLive),
    } satisfies AdminUsersResponse);
  }),
);

adminRouter.get(
  "/users/:username",
  asyncHandler(async (req, res) => {
    const lc = req.params.username.toLowerCase();
    const user = usersRepo.getAdmin(lc, isLive(lc));
    if (!user) throw notFound("user not found");
    res.json({ user });
  }),
);

const banSchema = z.object({ reason: z.string().max(500).optional() });

adminRouter.post(
  "/users/:username/ban",
  asyncHandler(async (req, res) => {
    const lc = req.params.username.toLowerCase();
    const target = usersRepo.getRaw(lc);
    if (!target) throw notFound("user not found");
    if (lc === req.auth!.usernameLc)
      throw badRequest("you cannot ban yourself");
    if (target.role === "admin") throw forbidden("cannot ban another admin");

    const { reason } = banSchema.parse(req.body);
    usersRepo.ban(lc, reason?.trim() || null);
    // Immediately cut off: revoke sessions + force-end any live broadcast so
    // it drops out of discovery and stops issuing tickets.
    revokeAllRefreshTokens(lc);
    const ended = broadcastsRepo.endAllForUser(lc);
    auditRepo.log(req.auth!.usernameLc, "ban", lc, reason?.trim() || undefined);
    res.json({
      ok: true,
      user: usersRepo.getAdmin(lc, false),
      endedLive: ended,
    });
  }),
);

adminRouter.post(
  "/users/:username/unban",
  asyncHandler(async (req, res) => {
    const lc = req.params.username.toLowerCase();
    if (!usersRepo.getRaw(lc)) throw notFound("user not found");
    usersRepo.unban(lc);
    auditRepo.log(req.auth!.usernameLc, "unban", lc);
    res.json({ ok: true, user: usersRepo.getAdmin(lc, isLive(lc)) });
  }),
);

adminRouter.delete(
  "/users/:username",
  asyncHandler(async (req, res) => {
    const lc = req.params.username.toLowerCase();
    if (!usersRepo.getRaw(lc)) throw notFound("user not found");
    if (lc === req.auth!.usernameLc)
      throw badRequest("use DELETE /users/me to delete your own account");
    broadcastsRepo.endAllForUser(lc);
    revokeAllRefreshTokens(lc);
    recordingsRepo.deleteAllForUser(lc);
    auditRepo.log(req.auth!.usernameLc, "user_delete", lc);
    usersRepo.delete(lc);
    res.json({ ok: true });
  }),
);

const roleSchema = z.object({ role: z.enum(["user", "admin"]) });

adminRouter.put(
  "/users/:username/role",
  asyncHandler(async (req, res) => {
    const lc = req.params.username.toLowerCase();
    if (!usersRepo.getRaw(lc)) throw notFound("user not found");
    if (lc === req.auth!.usernameLc) {
      throw badRequest("you cannot change your own role");
    }
    const { role } = roleSchema.parse(req.body);
    usersRepo.setRole(lc, role);
    auditRepo.log(req.auth!.usernameLc, "role_change", lc, role);
    res.json({ ok: true, user: usersRepo.getAdmin(lc, isLive(lc)) });
  }),
);

// ─── Broadcast takedown ──────────────────────────────────────────────────

adminRouter.post(
  "/broadcasts/:id/takedown",
  asyncHandler(async (req, res) => {
    const ended = broadcastsRepo.adminEnd(req.params.id);
    if (!ended) throw notFound("broadcast not found");
    auditRepo.log(req.auth!.usernameLc, "takedown", req.params.id, ended.title);
    res.json({ ok: true, broadcast: ended });
  }),
);

// ─── Metrics ───────────────────────────────────────────────────────────

adminRouter.get(
  "/metrics",
  asyncHandler(async (req, res) => {
    const days = Math.min(
      Math.max(Number.parseInt(String(req.query.days ?? "30"), 10) || 30, 7),
      90,
    );
    res.json({
      metrics: metricsRepo.summary(days),
      days,
    } satisfies AdminMetricsResponse);
  }),
);

// ─── Reports ─────────────────────────────────────────────────────────────

adminRouter.get(
  "/reports",
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? "open");
    const valid = ["open", "resolved", "dismissed", "all"] as const;
    const s = (valid as readonly string[]).includes(status) ? status : "open";
    res.json({
      reports: reportsRepo.list(s as "open" | "resolved" | "dismissed" | "all"),
      openCount: reportsRepo.countOpen(),
    } satisfies AdminReportsResponse & { openCount: number });
  }),
);

const resolveSchema = z.object({ status: z.enum(["resolved", "dismissed"]) });

adminRouter.post(
  "/reports/:id/resolve",
  asyncHandler(async (req, res) => {
    const { status } = resolveSchema.parse(req.body);
    const report = reportsRepo.resolve(
      req.params.id,
      status,
      req.auth!.usernameLc,
    );
    if (!report) throw notFound("report not found");
    auditRepo.log(
      req.auth!.usernameLc,
      "report_resolve",
      req.params.id,
      `${status} — ${report.targetUsername}`,
    );
    res.json({ ok: true, report });
  }),
);

// ─── Invites ───────────────────────────────────────────────────

adminRouter.get(
  "/invites",
  asyncHandler(async (_req, res) => {
    res.json({ invites: invitesRepo.list() });
  }),
);

const createInviteSchema = z.object({
  note: z.string().trim().max(200).optional(),
  maxUses: z.number().int().min(1).max(100000).nullish(),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .nullish(),
});

adminRouter.post(
  "/invites",
  asyncHandler(async (req, res) => {
    const body = createInviteSchema.parse(req.body);
    const invite = invitesRepo.create({
      note: body.note?.trim() || null,
      maxUses: body.maxUses ?? null,
      expiresAt: body.expiresInHours
        ? Date.now() + body.expiresInHours * 3600_000
        : null,
      createdBy: req.auth!.usernameLc,
    });
    auditRepo.log(req.auth!.usernameLc, "invite_create", invite.code);
    res.status(201).json({ ok: true, invite });
  }),
);

adminRouter.post(
  "/invites/:code/disable",
  asyncHandler(async (req, res) => {
    const invite = invitesRepo.disable(req.params.code.toUpperCase());
    if (!invite) throw notFound("invite not found");
    auditRepo.log(req.auth!.usernameLc, "invite_disable", invite.code);
    res.json({ ok: true, invite });
  }),
);

// ─── Audit log ─────────────────────────────────────────────────────────

adminRouter.get(
  "/audit",
  asyncHandler(async (req, res) => {
    const cursor = Number(req.query.cursor) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const { entries, nextCursor } = auditRepo.list(cursor, limit);
    res.json({ entries, nextCursor, limit });
  }),
);
