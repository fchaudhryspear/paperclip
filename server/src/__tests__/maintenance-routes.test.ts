import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getMaintenanceState,
  maintenanceRoutes,
  resetMaintenanceStateForTests,
} from "../routes/maintenance.js";

function buildApp(token?: string) {
  const app = express();
  app.use(express.json());
  app.use("/api/maintenance", maintenanceRoutes({ token: token ?? "" }));
  return app;
}

const AUTH = { Authorization: "Bearer test-token" };

describe("maintenance routes (ALL-1013)", () => {
  beforeEach(() => {
    resetMaintenanceStateForTests();
  });

  it("fails closed with 503 when no token is configured", async () => {
    const app = buildApp("");
    const start = await request(app)
      .patch("/api/maintenance/start")
      .set("Authorization", "Bearer anything")
      .send({ status: "paused" });
    expect(start.status).toBe(503);
    const finish = await request(app)
      .patch("/api/maintenance/finish")
      .set("Authorization", "Bearer anything")
      .send({ status: "active" });
    expect(finish.status).toBe(503);
  });

  it("rejects missing and wrong bearer tokens with 401", async () => {
    const app = buildApp("test-token");
    const missing = await request(app).patch("/api/maintenance/start").send({ status: "paused" });
    expect(missing.status).toBe(401);
    const wrong = await request(app)
      .patch("/api/maintenance/start")
      .set("Authorization", "Bearer nope")
      .send({ status: "paused" });
    expect(wrong.status).toBe(401);
  });

  it("start pauses maintenance and echoes the paused contract", async () => {
    const app = buildApp("test-token");
    const res = await request(app)
      .patch("/api/maintenance/start")
      .set(AUTH)
      .send({ status: "paused", pauseReason: "gateway_restart_safety" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "paused", pauseReason: "gateway_restart_safety" });
    expect(typeof res.body.updatedAt).toBe("string");
    expect(getMaintenanceState().status).toBe("paused");
  });

  it("start is idempotent while already paused", async () => {
    const app = buildApp("test-token");
    const first = await request(app).patch("/api/maintenance/start").set(AUTH).send({ status: "paused" });
    const second = await request(app).patch("/api/maintenance/start").set(AUTH).send({ status: "paused" });
    expect(second.status).toBe(200);
    expect(second.body.updatedAt).toBe(first.body.updatedAt);
  });

  it("rejects unexpected body status with 422", async () => {
    const app = buildApp("test-token");
    const start = await request(app).patch("/api/maintenance/start").set(AUTH).send({ status: "active" });
    expect(start.status).toBe(422);
    const finish = await request(app).patch("/api/maintenance/finish").set(AUTH).send({ status: "paused" });
    expect(finish.status).toBe(422);
  });

  it("finish resumes and is idempotent when already active", async () => {
    const app = buildApp("test-token");
    await request(app).patch("/api/maintenance/start").set(AUTH).send({ status: "paused" });
    const finish = await request(app).patch("/api/maintenance/finish").set(AUTH).send({ status: "active" });
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe("active");
    expect(getMaintenanceState().status).toBe("active");
    const repeat = await request(app).patch("/api/maintenance/finish").set(AUTH).send({ status: "active" });
    expect(repeat.status).toBe(200);
    expect(repeat.body.status).toBe("active");
  });
});
