import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { ExpressPeerServer } from "peer";
import { config } from "../config.js";
import {
  consumeSignalingTicket,
  consumeSignalingTicketSync,
  verifyAccessToken,
} from "../lib/auth.js";
import { usersRepo } from "../repos/users.js";

/**
 * Mount a self-hosted PeerJS signaling server on the given HTTP server.
 *
 * Auth-gated signaling: we reject the WebSocket upgrade before the handshake
 * for banned accounts so they never register on the signaling server.
 *
 * Token lookup order:
 *   1. Opaque signaling ticket (issued by POST /api/auth/signaling-ticket).
 *      These are short-lived (2 min), single-use, and don't appear in logs
 *      as meaningful credentials.
 *   2. Raw JWT access token (legacy / backward-compat path). JWTs in URL
 *      query strings appear in reverse-proxy access logs; prefer tickets.
 *
 * Anonymous connections (no token, or token that doesn't decode) are allowed;
 * banned users are already undiscoverable at the API layer.
 *
 * Reconnect caveat: PeerJS auto-reconnect reuses the same signaling URL/token.
 * The single-use ticket is consumed on the first open, so a reconnecting peer
 * falls back to the anonymous path (allowed) — this is by design and matches
 * the rendezvous-only moderation model. Never put the raw JWT in the URL.
 *
 * Multi-instance caveat: with REDIS_URL set, the ticket store is shared and
 * validated asynchronously. The socket may briefly race PeerJS's own upgrade
 * listener before the ban check completes (defense-in-depth — rendezvous-only
 * moderation is already enforced at the API layer). Without Redis the ticket
 * consume stays synchronous, so the eviction still beats the handshake.
 */
function evictIfBanned(usernameLc: string | null, socket: Duplex): boolean {
  if (usernameLc && usersRepo.isBanned(usernameLc)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    if (config.nodeEnv !== "production") {
      console.warn(`[peerjs] rejected upgrade for banned @${usernameLc}`);
    }
    return true;
  }
  return false;
}

export function createPeerServer(httpServer: Server) {
  httpServer.on("upgrade", async (req, socket) => {
    try {
      if (!req.url) return;
      const url = new URL(req.url, "http://localhost");
      if (!url.pathname.startsWith(config.signal.path)) return;

      const rawToken = url.searchParams.get("token");
      if (!rawToken) return; // anonymous/public peer — allowed

      // 1. Try opaque signaling ticket first. In-memory store: synchronous, so
      //    the ban check runs before PeerJS's own upgrade listener. Redis
      //    store (REDIS_URL set): shared across instances, async (see above).
      let usernameLc: string | null;
      if (config.redis.url) {
        usernameLc = await consumeSignalingTicket(rawToken);
      } else {
        usernameLc = consumeSignalingTicketSync(rawToken);
      }

      // 2. Fall back to JWT (old path, for backward compat). The claim must
      //    still match the account's current token version — a reset/revoked
      //    access token must not authenticate signaling either.
      if (!usernameLc) {
        const claims = verifyAccessToken(rawToken);
        if (claims) {
          const user = usersRepo.getRaw(claims.sub);
          if (user && user.token_version === claims.tv) {
            usernameLc = claims.sub;
          }
        }
      }

      if (evictIfBanned(usernameLc, socket)) {
        // Socket already destroyed above; return to skip the rest of our
        // handler. PeerJS's own upgrade listener still fires but operates on a
        // closed socket (harmless).
        return;
      }
    } catch {
      /* let PeerJS handle malformed upgrades */
    }
  });

  const peerServer = ExpressPeerServer(httpServer, {
    path: "/",
    key: config.signal.key,
    allow_discovery: false,
  });

  if (config.nodeEnv !== "production") {
    peerServer.on("connection", (client) =>
      console.log(`[peerjs] connect ${client.getId()}`),
    );
    peerServer.on("disconnect", (client) =>
      console.log(`[peerjs] disconnect ${client.getId()}`),
    );
  }

  return peerServer;
}
