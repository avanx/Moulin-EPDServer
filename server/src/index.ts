import { setDefaultResultOrder } from "node:dns";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { setDefaultAutoSelectFamily } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { config, getMasterKey, initMasterKey } from "./config.js";
import { bootstrapDatabase } from "./db/bootstrap.js";
import { closeDatabase } from "./db/index.js";
import { closeRenderingService } from "./rendering/service.js";
import { adminRoutes } from "./routes/admin.js";
import { deviceRoutes } from "./routes/device.js";
import { healthRoutes } from "./routes/health.js";
import { loadSchedules, stopScheduler } from "./scheduler.js";
import { registry } from "./widgets/registry.js";

// curl 往往正常，但 Node undici 默认双栈竞速：IPv6 ENETUNREACH 时可能把仍可用的
// IPv4 一并判失败（AggregateError / ETIMEDOUT）。关闭自动选族并优先 IPv4。
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);

async function registerFrontend(app: FastifyInstance): Promise<void> {
  if (!config.frontendDir) return;
  const indexHtml = join(config.frontendDir, "index.html");
  if (!existsSync(indexHtml)) {
    app.log.warn(
      { frontendDir: config.frontendDir },
      "EPD_FRONTEND_DIR is set but index.html was not found; static UI disabled",
    );
    return;
  }

  await app.register(fastifyStatic, {
    root: config.frontendDir,
    wildcard: false,
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    // Do not SPA-fallback asset requests: returning index.html as JS/CSS
    // triggers "Expected a JavaScript module but got text/html".
    const looksLikeAsset = /\.[a-zA-Z0-9]+$/.test(path);
    if (
      request.method === "GET" &&
      !looksLikeAsset &&
      !path.startsWith("/api") &&
      !path.startsWith("/health")
    ) {
      return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "Not Found" });
  });

  app.log.info({ frontendDir: config.frontendDir }, "Serving frontend static assets");
}

export async function buildApp(): Promise<FastifyInstance> {
  await Promise.all([
    mkdir(config.dataDir, { recursive: true }),
    mkdir(config.snapshotDir, { recursive: true }),
  ]);
  initMasterKey();
  if (!config.debug && (
    getMasterKey().startsWith("development-") ||
    config.adminPassword === "change-me-now"
  )) {
    throw new Error(
      "Set a non-development EPD_MASTER_KEY (or omit it to auto-generate) and a non-default EPD_ADMIN_PASSWORD before production startup",
    );
  }
  await registry.load();
  await bootstrapDatabase();

  const app = Fastify({
    trustProxy: true,
    logger: {
      level: config.debug ? "debug" : "info",
    },
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.allowedOrigins,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "X-API-Key"],
  });
  await app.register(healthRoutes);
  await app.register(adminRoutes);
  await app.register(deviceRoutes);
  await registerFrontend(app);
  loadSchedules();

  app.addHook("onClose", async () => {
    stopScheduler();
    await closeRenderingService();
    closeDatabase();
  });

  return app;
}

export async function start(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.listen({ host: config.host, port: config.port });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, "Shutting down");
    await app.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return app;
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
