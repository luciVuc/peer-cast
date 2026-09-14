import { Router } from "express";
import { z } from "zod";
import {
  existsSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import type {
  AppendChunkResponse,
  RecordingListResponse,
  RecordingResponse,
} from "@peer-cast/shared";
import { config } from "../config.js";
import { badRequest, notFound } from "../lib/errors.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { broadcastsRepo } from "../repos/broadcasts.js";
import * as recordingsRepo from "../repos/recordings.js";

export const recordingsRouter = Router();

recordingsRouter.use(requireAuth);

// ─── My recordings (dashboard replay list) ───────────────────────────────────

recordingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({
      recordings: recordingsRepo.listForUser(req.auth!.usernameLc),
    } satisfies RecordingListResponse);
  }),
);

// ─── Start a recording (backend must create the row before the first chunk) ─

const createSchema = z.object({
  title: z.string().trim().max(200).nullish(),
  broadcastId: z.string().max(64).nullish(),
});

recordingsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    // A recording is only meaningful while its broadcast belongs to the caller.
    if (body.broadcastId) {
      const b = broadcastsRepo.get(body.broadcastId);
      if (!b || b.username.toLowerCase() !== req.auth!.usernameLc) {
        throw badRequest("broadcastId does not belong to you");
      }
    }
    recordingsRepo.recordingsDir(); // ensure the storage dir exists
    const recording = recordingsRepo.createRecording({
      usernameLc: req.auth!.usernameLc,
      title: body.title?.trim() || "Live broadcast",
      broadcastId: body.broadcastId ?? null,
    });
    res.status(201).json({ recording } satisfies RecordingResponse);
  }),
);

// ─── Binary chunk upload ────────────────────────────────────────────────────
// Raw bytes arrive as application/octet-stream. The shared express.json
// middleware ignores non-JSON bodies, so a route-local raw reader handles the
// stream. Per-chunk cap protects memory; the per-recording cap is checked below.

const CHUNK_LIMIT_BYTES = 25 * 1024 * 1024;

recordingsRouter.put(
  "/:id/chunk",
  async (req, res, next) => {
    try {
      const parts: Buffer[] = [];
      let total = 0;
      let oversize = false;
      for await (const c of req) {
        total += (c as Buffer).length;
        if (total > CHUNK_LIMIT_BYTES) {
          oversize = true;
          break; // stop draining; the client already sent the payload
        }
        parts.push(c as Buffer);
      }
      if (oversize) {
        res.status(413).json({
          error: "request entity too large",
          code: "PAYLOAD_TOO_LARGE",
        });
        return;
      }
      req.body = Buffer.concat(parts);
      next();
    } catch (err) {
      next(err);
    }
  },
  asyncHandler(async (req, res) => {
    const rec = recordingsRepo.getOwned(req.params.id, req.auth!.usernameLc);
    if (!rec) throw notFound("recording not found");
    if (rec.status !== "recording") {
      throw badRequest("this recording is already finalised");
    }
    const body = req.body as Buffer;
    const len = body.length;
    if (rec.sizeBytes + len > config.recordings.maxBytes) {
      throw badRequest(
        `recording size limit (${config.recordings.maxBytes} bytes) exceeded`,
        "RECORDING_TOO_LARGE",
      );
    }
    const usedBytes = recordingsRepo.totalBytesForUser(req.auth!.usernameLc);
    if (usedBytes + len > config.recordings.maxBytesPerUser) {
      throw badRequest(
        `per-user recording quota (${config.recordings.maxBytesPerUser} bytes) exceeded`,
        "RECORDING_QUOTA_EXCEEDED",
      );
    }
    appendFileSync(recordingsRepo.partFileOf(rec.id), body);
    const sizeBytes = recordingsRepo.appendBytes(rec.id, len);
    res.json({ ok: true, sizeBytes } satisfies AppendChunkResponse);
  }),
);

// ─── Finalize (rename .part → .webm, mark complete) ─────────────────────────

const finalizeSchema = z.object({
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600_000)
    .default(0),
});

recordingsRouter.post(
  "/:id/finalize",
  asyncHandler(async (req, res) => {
    const rec = recordingsRepo.getOwned(req.params.id, req.auth!.usernameLc);
    if (!rec) throw notFound("recording not found");
    if (rec.status !== "recording") {
      throw badRequest("this recording is already finalised");
    }
    const { durationMs } = finalizeSchema.parse(req.body);
    const part = recordingsRepo.partFileOf(rec.id);
    const final = recordingsRepo.replayFileOf(rec.id);
    if (existsSync(part)) {
      renameSync(part, final);
    } else {
      writeFileSync(final, Buffer.alloc(0)); // zero-length replay
    }
    const recording = recordingsRepo.finalize(rec.id, durationMs)!;
    res.json({ recording } satisfies RecordingResponse);
  }),
);

// ─── Single recording metadata ───────────────────────────────────────────────

recordingsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const rec = recordingsRepo.getOwned(req.params.id, req.auth!.usernameLc);
    if (!rec) throw notFound("recording not found");
    res.json({ recording: rec } satisfies RecordingResponse);
  }),
);

// ─── Replay stream (owner-only; sendFile gives us HTTP Range support) ───────

recordingsRouter.get(
  "/:id/data",
  asyncHandler(async (req, res) => {
    const rec = recordingsRepo.getOwned(req.params.id, req.auth!.usernameLc);
    if (!rec) throw notFound("recording not found");
    const file = recordingsRepo.replayFileOf(rec.id);
    if (!existsSync(file)) throw notFound("recording file not found");
    res.sendFile(file, {
      headers: {
        "Content-Type": "video/webm",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }),
);

// ─── Delete recording (row + files) ──────────────────────────────────────────

recordingsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const rec = recordingsRepo.getOwned(req.params.id, req.auth!.usernameLc);
    if (!rec) throw notFound("recording not found");
    recordingsRepo.remove(rec.id);
    rmSync(recordingsRepo.partFileOf(rec.id), { force: true });
    rmSync(recordingsRepo.replayFileOf(rec.id), { force: true });
    res.json({ ok: true });
  }),
);
