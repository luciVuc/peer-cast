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
  };
  res.json(out);
});
