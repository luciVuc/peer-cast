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
  };
  res.json(out);
});
