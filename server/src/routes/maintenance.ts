// Maintenance endpoints implementing the gateway-safe-restart.sh contract (ALL-727 step 5).
// PATCH /api/maintenance/gateway-restart  {"status":"paused","pauseReason":string} → pauses heartbeat run scheduling
// PATCH /api/maintenance/gateway-restart  {"status":"active"} → resumes scheduling
// State lives in a JSON flag file (PAPERCLIP_GATEWAY_MAINTENANCE_FLAG, default /tmp/paperclip-gateway-maintenance.json)
// read by resolveHeartbeatSchedulingSuppression() on every scheduler tick.
// Access: local-only operator surface. Requires a bearer token when PAPERCLIP_MAINTENANCE_TOKEN is set
// (the safe-restart script sends it). Deployment is local_trusted; this route additionally refuses
// non-loopback callers when deployment exposure is private.
import { Router, type Request, type Response } from "express";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAINTENANCE_TAG = "[maintenance]";

function maintenanceFlagPath(): string {
  return process.env.PAPERCLIP_GATEWAY_MAINTENANCE_FLAG ?? "/tmp/paperclip-gateway-maintenance.json";
}

type MaintenanceState = {
  status: "active" | "paused";
  pauseReason?: string;
  pausedAt?: string;
  updatedAt: string;
};

export function maintenanceRoutes(opts: {
  requireLoopback?: boolean;
  logger?: { info?: (obj: unknown, msg: string) => void; warn?: (obj: unknown, msg: string) => void };
} = {}): Router {
  const router = Router();
  const logger = opts.logger;

  const readState = (): MaintenanceState => {
    try {
      const raw = fs.readFileSync(maintenanceFlagPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<MaintenanceState>;
      if (parsed.status === "paused") {
        return {
          status: "paused",
          pauseReason: typeof parsed.pauseReason === "string" ? parsed.pauseReason : undefined,
          pausedAt: typeof parsed.pausedAt === "string" ? parsed.pausedAt : undefined,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        };
      }
    } catch {
      // missing/corrupt flag = active
    }
    return { status: "active", updatedAt: new Date().toISOString() };
  };

  const writeState = (state: MaintenanceState): void => {
    const flagPath = maintenanceFlagPath();
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    const tmp = `${flagPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, flagPath);
  };

  const isLoopback = (req: Request): boolean => {
    const addr =
      (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "") ||
      (req.ip ?? "");
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr === "localhost";
  };

  const authorized = (req: Request): boolean => {
    const expected = process.env.PAPERCLIP_MAINTENANCE_TOKEN;
    if (!expected) return true; // local_trusted deployment without token configured
    const header = req.header("authorization") ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    return supplied.length > 0 && supplied === expected;
  };

  router.patch("/maintenance/gateway-restart", (req: Request, res: Response) => {
    if (opts.requireLoopback !== false && !isLoopback(req)) {
      res.status(403).json({ error: "maintenance endpoints are loopback-only" });
      return;
    }
    if (!authorized(req)) {
      res.status(401).json({ error: "invalid maintenance token" });
      return;
    }
    const body = (req.body ?? {}) as { status?: unknown; pauseReason?: unknown };
    const status = body.status;
    const now = new Date().toISOString();
    if (status === "paused") {
      const reason = typeof body.pauseReason === "string" ? body.pauseReason.slice(0, 200) : "unspecified";
      const state: MaintenanceState = { status: "paused", pauseReason: reason, pausedAt: now, updatedAt: now };
      try {
        writeState(state);
      } catch (err) {
        logger?.warn?.({ err }, "maintenance pause flag write failed");
        res.status(500).json({ error: "failed to write maintenance flag" });
        return;
      }
      logger?.info?.({ pauseReason: reason }, "gateway-restart maintenance pause engaged");
      // Echo the shape gateway-safe-restart.sh parses: status + updatedAt.
      res.json({ status: "paused", pauseReason: reason, pausedAt: now, updatedAt: now, activeRunIds: [] });
      return;
    }
    if (status === "active") {
      try {
        writeState({ status: "active", updatedAt: now });
      } catch (err) {
        logger?.warn?.({ err }, "maintenance resume flag write failed");
        res.status(500).json({ error: "failed to write maintenance flag" });
        return;
      }
      logger?.info?.({}, "gateway-restart maintenance pause released");
      res.json({ status: "active", updatedAt: now });
      return;
    }
    res.status(400).json({ error: 'status must be "paused" or "active"' });
  });

  router.get("/maintenance/gateway-restart", (req: Request, res: Response) => {
    if (opts.requireLoopback !== false && !isLoopback(req)) {
      res.status(403).json({ error: "maintenance endpoints are loopback-only" });
      return;
    }
    if (!authorized(req)) {
      res.status(401).json({ error: "invalid maintenance token" });
      return;
    }
    const state = readState();
    res.json({ ...state, host: os.hostname(), tag: MAINTENANCE_TAG });
  });

  return router;
}
