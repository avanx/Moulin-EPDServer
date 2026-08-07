import type { FastifyPluginAsync } from "fastify";

import { config } from "../config.js";
import { checkDatabase } from "../db/index.js";
import {
  HealthResponseSchema,
  type HealthResponse,
} from "../schemas/health.js";
import { schedulerRunning } from "../scheduler.js";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        response: {
          200: HealthResponseSchema,
        },
      },
    },
    async (): Promise<HealthResponse> => {
      checkDatabase();
      return {
        status: "ok",
        database: "ok",
        scheduler: schedulerRunning(),
        version: config.version,
        gitSha: config.gitSha,
        buildTime: config.buildTime,
      };
    },
  );
};
