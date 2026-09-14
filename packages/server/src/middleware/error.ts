import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";

/** Wrap async route handlers so thrown errors reach the error middleware. */
export function asyncHandler<
  T extends (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<unknown>,
>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: err.issues[0]?.message ?? "invalid request",
      code: "VALIDATION",
    });
    return;
  }
  // Malformed JSON body (body-parser) → 400, not 500.
  if (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as { status?: number }).status === 400
  ) {
    res.status(400).json({ error: "invalid JSON body", code: "BAD_JSON" });
    return;
  }
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "internal server error" });
}
