import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "@peer-cast/shared";
import { verifyAccessToken } from "../lib/auth.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { usersRepo } from "../repos/users.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { usernameLc: string; username: string; role: UserRole };
    }
  }
}

function extract(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

/**
 * Require a valid access token AND a non-banned account. We re-check the live
 * user row on every request (cheap with SQLite) so bans take effect
 * immediately, even though the JWT itself is stateless.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extract(req);
  const claims = token ? verifyAccessToken(token) : null;
  if (!claims) return next(unauthorized());
  const user = usersRepo.getRaw(claims.sub);
  if (!user) return next(unauthorized());
  if (user.banned) return next(forbidden("account suspended", "BANNED"));
  if (claims.tv !== user.token_version)
    return next(unauthorized("session revoked", "TOKEN_STALE"));
  req.auth = {
    usernameLc: user.username_lc,
    username: user.username,
    role: user.role as UserRole,
  };
  next();
}

/** Attach req.auth if a valid, non-banned token is present; never block. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extract(req);
  const claims = token ? verifyAccessToken(token) : null;
  if (claims) {
    const user = usersRepo.getRaw(claims.sub);
    if (user && !user.banned && claims.tv === user.token_version) {
      req.auth = {
        usernameLc: user.username_lc,
        username: user.username,
        role: user.role as UserRole,
      };
    }
  }
  next();
}

/** Require an authenticated admin (chain after requireAuth). */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  if (req.auth.role !== "admin")
    return next(forbidden("admin only", "ADMIN_ONLY"));
  next();
}
