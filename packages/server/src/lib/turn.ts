import { createHmac } from "node:crypto";
import type { RTCIceServerConfig } from "@peer-cast/shared";

const isTurnUrl = (url: string) =>
  url.startsWith("turn:") || url.startsWith("turns:");

export interface TurnCredentials {
  username: string;
  credential: string;
}

/**
 * Generate time-limited TURN credentials following the TURN REST API flow
 * (`use-auth-secret` in coturn terminology):
 *
 *   username   = "<unix expiry timestamp>:<userid>"
 *   credential = base64( HMAC-SHA1( sharedSecret, username ) )
 *
 * coturn validates the HMAC and refuses credentials past `<expiry timestamp>`.
 * This lets operators rotate the advertised secret without touching
 * turnserver.conf — every client requesting ICE config gets fresh creds.
 */
export function turnCredentials(
  secret: string,
  ttlSec: number,
  userid: string,
): TurnCredentials {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const username = `${expiresAt}:${userid}`;
  const credential = createHmac("sha1", secret)
    .update(username)
    .digest("base64");
  return { username, credential };
}

/**
 * Enrich a parsed `ICE_SERVERS` list with ephemeral TURN credentials.
 *
 * Every entry whose urls include a `turn:`/`turns:` URL gets the generated
 * `username`/`credential`, overriding any static ones from the JSON. STUN
 * entries (and other ICE servers) are returned untouched.
 */
export function withTurnCredentials(
  iceServers: RTCIceServerConfig[],
  secret: string,
  ttlSec: number,
  userid: string,
): RTCIceServerConfig[] {
  const creds = turnCredentials(secret, ttlSec, userid);
  return iceServers.map((srv) => {
    const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
    if (!urls.some(isTurnUrl)) return srv;
    return { ...srv, username: creds.username, credential: creds.credential };
  });
}
