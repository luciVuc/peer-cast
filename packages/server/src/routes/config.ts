import { Router } from "express";
import type { RuntimeConfig } from "@peer-cast/shared";
import { config } from "../config.js";
import { withTurnCredentials } from "../lib/turn.js";

export const configRouter = Router();

configRouter.get("/", (_req, res) => {
  const out: RuntimeConfig = {
    appName: config.appName,
    version: config.version,
    registration: config.registrationMode,
    // Only meaningful while registration is actually gated. Advertising it
    // unconditionally tells any anonymous prober whether this instance has an
    // unclaimed admin bootstrap path, which is reconnaissance for exactly the
    // operator secret it protects. In open mode the field is irrelevant to the
    // client anyway (RegisterPage only consults it when mode === "closed"), so
    // report false rather than leaking the configuration.
    adminBootstrap:
      config.registrationMode === "closed" && !!config.adminBootstrapSecret,
    signal: {
      host: config.signal.host,
      port: config.signal.port,
      path: config.signal.path,
      secure: config.signal.secure,
      key: config.signal.key,
      iceServers: config.turn.sharedSecret
        ? withTurnCredentials(
            config.signal.iceServers,
            config.turn.sharedSecret,
            config.turn.ttlSec,
            config.turn.userid,
          )
        : config.signal.iceServers,
    },
    // Absent unless the operator configured a usable budget — an unshaped mesh
    // is the default and the client treats a missing policy as "apply no caps".
    // Re-validated here, not just in parseBitrate(): a non-positive budget or an
    // empty ladder would reach the client as a policy that caps every viewer at
    // 0 kbps, which presents as a broken broadcast rather than a misconfig.
    ...(config.bitrate &&
    config.bitrate.budgetKbps > 0 &&
    config.bitrate.tiersKbps.length > 0
      ? { bitrate: config.bitrate }
      : {}),
  };
  res.json(out);
});
