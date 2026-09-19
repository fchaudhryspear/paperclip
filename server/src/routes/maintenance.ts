import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, RequestHandler } from "express";

/**
 * Gateway maintenance handoff endpoints (ALL-1013 / ALL-727 contract step 5).
 *
 * Consumed by ~/.openclaw/bin/gateway-safe-restart.sh:
 *   PATCH /api/maintenance/start   body {"status":"paused","pauseReason":"gateway_restart_safety"}
 *     -> 200 {"status":"paused","updatedAt":"<ISO>","pauseReason":"..."}
 *   PATCH /api/maintenance/finish  body {"status":"active"}
 *     -> 200 {"status":"active","updatedAt":"<ISO>"}
 *
 * Auth: Authorization: Bearer *** (constant-time compare).
 * Fail-closed: if the token is not configured, both endpoints return 503 and
 * the restart script surfaces paperclip_maintenance_start_failed — an
 * unconfigured instance never accepts maintenance control.
 *
 * State is in-process. A gateway restart does not bounce Paperclip, so the
 * paused latch survives the restart window it guards. A Paperclip crash
 * between start and finish drops the latch, which the restart script already
 * treats as the safe "resumed" outcome.
 */

export type MaintenanceStatus = "active" | "paused";

export interface MaintenanceState {
  status: MaintenanceStatus;
  updatedAt: string;
  pauseReason: string | null;
}

let state: MaintenanceState = {
  status: "active",
  updatedAt: new Date(0).toISOString(),
  pauseReason: null,
};

export function getMaintenanceState(): MaintenanceState {
  return state;
}

export function resetMaintenanceStateForTests(): void {
  state = { status: "active", updatedAt: new Date(0).toISOString(), pauseReason: null };
}

function maintenanceTokenFromRequest(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function tokensMatch(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function maintenanceRoutes(opts: { token?: string } = {}): Router {
  const router = Router();
  const token = (opts.token ?? process.env.PAPERCLIP_MAINTENANCE_TOKEN ?? "").trim();

  const requireConfigured: RequestHandler = (_req, res, next) => {
    if (!token) {
      res.status(503).json({
        error: "maintenance control is not configured (PAPERCLIP_MAINTENANCE_TOKEN unset)",
      });
      return;
    }
    next();
  };

  const requireToken: RequestHandler = (req, res, next) => {
    if (!tokensMatch(token, maintenanceTokenFromRequest(req))) {
      res.status(401).json({ error: "invalid or missing maintenance token" });
      return;
    }
    next();
  };

  router.patch("/start", requireConfigured, requireToken, (req, res) => {
    const body = (req.body ?? {}) as { status?: unknown; pauseReason?: unknown };
    if (body.status !== "paused") {
      res.status(422).json({ error: 'expected body {"status":"paused"}' });
      return;
    }
    if (state.status !== "paused") {
      const pauseReason =
        typeof body.pauseReason === "string" && body.pauseReason.trim().length > 0
          ? body.pauseReason.trim()
          : "unspecified";
      state = { status: "paused", updatedAt: new Date().toISOString(), pauseReason };
    }
    res
      .status(200)
      .json({ status: state.status, updatedAt: state.updatedAt, pauseReason: state.pauseReason });
  });

  router.patch("/finish", requireConfigured, requireToken, (req, res) => {
    const body = (req.body ?? {}) as { status?: unknown };
    if (body.status !== "active") {
      res.status(422).json({ error: 'expected body {"status":"active"}' });
      return;
    }
    if (state.status !== "active") {
      state = { status: "active", updatedAt: new Date().toISOString(), pauseReason: null };
    }
    res.status(200).json({ status: state.status, updatedAt: state.updatedAt });
  });

  return router;
}
