import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, ne, or } from "drizzle-orm";
import sharp from "sharp";

import { config } from "../config.js";
import { db, sqlite } from "../db/index.js";
import {
  adminSessions, adminUsers, deviceCredentials, pluginPackages, providerStates, screenPlugins,
  screens, secrets, snapshotRegions, snapshots, widgetInstances,
} from "../db/schema.js";
import { composeScreen, renderDraft, renderWidgetPreview } from "../rendering/service.js";
import {
  makeAdminSession, makeApiKey, verifyCsrfToken, verifyPassword, hashPassword,
  encryptSecret, decryptSecret, generateEd25519KeyPairPem, publicKeyPemFromPrivateKeyPem,
  isSessionExpired,
} from "../security.js";
import { renderScreen, scheduleScreen, unscheduleScreen } from "../scheduler.js";
import { runDataSource } from "../widgets/data-runner.js";
import { registry } from "../widgets/registry.js";

type Screen = typeof screens.$inferSelect;
type Widget = typeof widgetInstances.$inferSelect;
type Json = Record<string, unknown>;
type ScreenValues = Pick<Screen, "name" | "width" | "height" | "colorMode" | "panelLayout" | "refreshSeconds" | "enabled">;

const now = (): string => new Date().toISOString();
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const integer = (value: unknown, fallback = 0): number => Number.isInteger(value) ? value as number : fallback;
const bool = (value: unknown, fallback = false): boolean => typeof value === "boolean" ? value : fallback;
const availableColors = (colorMode: string): Set<string> =>
  new Set(colorMode === "bwry" ? ["black", "white", "red", "yellow"] : ["black", "white"]);

function pluginSupportsColorMode(type: string, colorMode: string): boolean {
  try {
    const available = availableColors(colorMode);
    return [...registry.get(type).styles.values()]
      .some((style) => style.requiredColors.every((color) => available.has(color)));
  } catch {
    return false;
  }
}

const knownProviderTypes = new Set(["cursor_usage", "weather", "weather-qweather", "bambu_print", "klipper_print"]);
const secretPurposes = new Set(["general_key", "cursor_session", "qweather_jwt"]);

function providerCacheKey(widget: Widget): string | undefined {
  const value = widget.config;
  if (widget.widgetType === "cursor_usage") {
    const secretId = String(value.secret_id ?? "");
    return secretId ? `widget:cursor_usage:cursor:current-period:${secretId}` : undefined;
  }
  if (widget.widgetType === "weather") {
    const latitude = Number(value.latitude);
    const longitude = Number(value.longitude);
    const unit = String(value.temperature_unit ?? "");
    return Number.isFinite(latitude) && Number.isFinite(longitude) && unit
      ? `widget:weather:weather:v2:${latitude.toFixed(4)}:${longitude.toFixed(4)}:${unit}`
      : undefined;
  }
  if (widget.widgetType === "weather-qweather") {
    const host = String(value.api_host ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
    const projectId = String(value.project_id ?? "");
    const kid = String(value.kid ?? "");
    const latitude = Number(value.latitude);
    const longitude = Number(value.longitude);
    return host && projectId && kid && Number.isFinite(latitude) && Number.isFinite(longitude)
      ? `widget:weather-qweather:weather-qweather:v1:${host}:${projectId}:${kid}:${latitude.toFixed(2)}:${longitude.toFixed(2)}`
      : undefined;
  }
  if (widget.widgetType === "bambu_print") {
    const host = String(value.host ?? "");
    const serial = String(value.serial ?? "");
    const secretId = String(value.access_secret_id ?? "");
    return host && serial && secretId
      ? `widget:bambu_print:bambu:${host}:${serial}:${secretId}`
      : undefined;
  }
  if (widget.widgetType === "klipper_print") {
    const compatibility = String(value.compatibility ?? "");
    const host = String(value.host ?? "");
    const port = Number(value.port) || 0;
    const secretId = String(value.api_secret_id ?? "").trim();
    return host && (compatibility === "general" || compatibility === "snapmaker_u1")
      ? `widget:klipper_print:klipper:${compatibility}:${host}:${port}:${secretId}`
      : undefined;
  }
  return undefined;
}

function pruneUnreferencedProviderStates(): void {
  const widgets = db.select().from(widgetInstances).all();
  const activeTypes = new Set(widgets.map((widget) => widget.widgetType));
  const activeKeys = new Set(widgets.map(providerCacheKey).filter((key): key is string => Boolean(key)));
  for (const state of db.select().from(providerStates).all()) {
    const match = /^widget:([^:]+):/.exec(state.cacheKey);
    if (match) {
      const type = match[1]!;
      if (!activeTypes.has(type) || (knownProviderTypes.has(type) && !activeKeys.has(state.cacheKey))) {
        db.delete(providerStates).where(eq(providerStates.id, state.id)).run();
      }
      continue;
    }
    const legacyType = state.cacheKey.startsWith("cursor:current-period:")
      ? "cursor_usage"
      : state.cacheKey.startsWith("weather:v2:")
        ? "weather"
        : state.cacheKey.startsWith("bambu:")
          ? "bambu_print"
          : undefined;
    if (legacyType) db.delete(providerStates).where(eq(providerStates.id, state.id)).run();
  }
}

function screenJson(row: Screen): Json {
  return {
    id: row.id, name: row.name, width: row.width, height: row.height, color_mode: row.colorMode,
    panel_layout: row.panelLayout,
    available_colors: row.colorMode === "bwry" ? ["black", "white", "red", "yellow"] : ["black", "white"],
    refresh_seconds: row.refreshSeconds, enabled: row.enabled,
    current_snapshot_id: row.currentSnapshotId, created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

function widgetJson(row: Widget): Json {
  return {
    id: row.id, screen_id: row.screenId, widget_type: row.widgetType, x: row.x, y: row.y,
    width: row.width, height: row.height, z_index: row.zIndex, alignment_margin: row.alignmentMargin,
    config: row.config, config_version: row.configVersion,
  };
}

function parseScreen(body: unknown, allowLegacyPanelLayout = false): ScreenValues {
  const value = object(body);
  const name = String(value.name ?? "");
  const width = integer(value.width);
  const height = integer(value.height);
  const colorMode = String(value.color_mode ?? "bw");
  const panelLayout = String(value.panel_layout ?? (
    allowLegacyPanelLayout
      ? width === 1360 && height === 480 ? "dual-panel-left-right" : "linear"
      : ""
  ));
  const refreshSeconds = integer(value.refresh_seconds, 900);
  if (!name || name.length > 120 || width < 16 || width > 4096 || height < 16 || height > 4096 ||
      !["bw", "bwry"].includes(colorMode) || refreshSeconds < 2 || refreshSeconds > 86400 ||
      !["linear", "dual-panel-left-right"].includes(panelLayout) ||
      (panelLayout === "dual-panel-left-right" && width % 2 !== 0) ||
      (value.enabled !== undefined && typeof value.enabled !== "boolean")) {
    throw new Error("Invalid screen configuration");
  }
  return {
    name, width, height, colorMode,
    panelLayout: panelLayout as Screen["panelLayout"],
    refreshSeconds, enabled: bool(value.enabled, true),
  };
}

function parseWidget(
  body: unknown,
  screen: Screen,
  id: string = crypto.randomUUID(),
  useMockDefaults = false,
): Widget {
  const value = object(body);
  const widgetType = String(value.widget_type ?? "");
  const x = integer(value.x), y = integer(value.y), width = integer(value.width), height = integer(value.height);
  const providedConfig = object(value.config);
  const candidateConfig = useMockDefaults
    ? { ...registry.get(widgetType).manifest.mockConfig, ...providedConfig }
    : providedConfig;
  const marginValue = object(value.alignment_margin);
  const alignmentMargin = {
    top: integer(marginValue.top),
    right: integer(marginValue.right),
    bottom: integer(marginValue.bottom),
    left: integer(marginValue.left),
  };
  if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > screen.width || y + height > screen.height) {
    throw new Error("Widget exceeds screen bounds");
  }
  if (Object.values(alignmentMargin).some((item) => item < 0)) {
    throw new Error("Widget alignment margins must be non-negative integers");
  }
  const rawConfig = registry.validate(widgetType, candidateConfig, screen.colorMode);
  const time = now();
  return {
    id, screenId: screen.id, widgetType, x, y, width, height, zIndex: integer(value.z_index),
    alignmentMargin,
    config: rawConfig,
    configVersion: 1, createdAt: time, updatedAt: time,
  };
}

function fail(reply: FastifyReply, status: number, detail?: string): FastifyReply {
  return reply.type("application/json").code(status).send(detail ? { detail } : {});
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<typeof adminUsers.$inferSelect | null> {
  const id = request.cookies.epd_session;
  if (!id) { fail(reply, 401); return null; }
  const session = db.select().from(adminSessions).where(eq(adminSessions.id, id)).get();
  if (!session || isSessionExpired(session.expiresAt)) {
    if (session) db.delete(adminSessions).where(eq(adminSessions.id, id)).run();
    fail(reply, 401); return null;
  }
  const supplied = typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : undefined;
  if (!verifyCsrfToken(request.method, supplied, session.csrfToken)) {
    fail(reply, 403, "Invalid CSRF token"); return null;
  }
  const user = db.select().from(adminUsers).where(eq(adminUsers.id, session.userId)).get();
  if (!user) { fail(reply, 401); return null; }
  (request as FastifyRequest & { adminSession: typeof session }).adminSession = session;
  return user;
}

function pluginJson(row: typeof pluginPackages.$inferSelect, enabled?: boolean): Json {
  return {
    ...row.pluginMetadata, type: row.typeName, packageName: row.packageName, version: row.version,
    sourceType: row.sourceType, sourceUrl: row.sourceUrl, sourceRef: row.sourceRef,
    status: row.status, loadError: row.loadError, ...(enabled === undefined ? {} : { enabled }),
  };
}

function syncPluginMetadata(type: string): void {
  db.update(pluginPackages).set({
    pluginMetadata: registry.get(type).metadata(),
    updatedAt: now(),
  }).where(eq(pluginPackages.typeName, type)).run();
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const prefix = "/api/v1/admin";

  app.post(`${prefix}/auth/login`, async (request, reply) => {
    const body = object(request.body);
    const user = db.select().from(adminUsers).where(eq(adminUsers.username, String(body.username ?? ""))).get();
    if (!user || !await verifyPassword(user.passwordHash, String(body.password ?? ""))) return fail(reply, 401, "Invalid credentials");
    const session = makeAdminSession(user.id);
    db.insert(adminSessions).values(session).run();
    reply.setCookie("epd_session", session.id, {
      httpOnly: true, secure: config.cookieSecure, sameSite: "strict", maxAge: config.sessionHours * 3600, path: "/",
    });
    return { username: user.username, csrfToken: session.csrfToken };
  });

  app.get(`${prefix}/auth/me`, async (request, reply) => {
    const user = await requireAdmin(request, reply); if (!user) return;
    const session = (request as FastifyRequest & { adminSession: typeof adminSessions.$inferSelect }).adminSession;
    return { username: user.username, csrfToken: session.csrfToken };
  });
  app.post(`${prefix}/auth/logout`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const id = request.cookies.epd_session!;
    db.delete(adminSessions).where(eq(adminSessions.id, id)).run();
    reply.clearCookie("epd_session", { path: "/" });
    return { ok: true };
  });

  app.get(`${prefix}/security`, async (request, reply) => {
    const user = await requireAdmin(request, reply); if (!user) return;
    return {
      adminUsername: user.username,
      masterKeyConfigured: true,
    };
  });

  app.post(`${prefix}/security`, async (request, reply) => {
    const user = await requireAdmin(request, reply); if (!user) return;
    const body = object(request.body);
    const currentPassword = String(body.currentPassword ?? "");
    if (!currentPassword || !await verifyPassword(user.passwordHash, currentPassword)) {
      return fail(reply, 401, "Invalid current password");
    }

    const nextUsername = body.adminUsername !== undefined
      ? String(body.adminUsername).trim()
      : user.username;
    const newPassword = body.newPassword !== undefined ? String(body.newPassword) : "";
    const confirmPassword = body.confirmPassword !== undefined ? String(body.confirmPassword) : "";

    if (!nextUsername || nextUsername.length > 80) {
      return fail(reply, 422, "Username must be 1-80 characters");
    }
    if (newPassword) {
      if (newPassword.length < 8) return fail(reply, 422, "Password must be at least 8 characters");
      if (newPassword === "change-me-now") return fail(reply, 422, "Choose a stronger password");
      if (newPassword !== confirmPassword) return fail(reply, 422, "Password confirmation does not match");
    } else if (nextUsername === user.username) {
      return fail(reply, 422, "No changes requested");
    }

    if (nextUsername !== user.username) {
      const clash = db.select().from(adminUsers).where(eq(adminUsers.username, nextUsername)).get();
      if (clash && clash.id !== user.id) return fail(reply, 409, "Username already taken");
    }

    const time = now();
    const updates: { username?: string; passwordHash?: string; updatedAt: string } = { updatedAt: time };
    if (nextUsername !== user.username) updates.username = nextUsername;
    if (newPassword) updates.passwordHash = await hashPassword(newPassword);

    db.update(adminUsers).set(updates).where(eq(adminUsers.id, user.id)).run();

    if (newPassword) {
      const sessionId = request.cookies.epd_session!;
      db.delete(adminSessions).where(and(
        eq(adminSessions.userId, user.id),
        ne(adminSessions.id, sessionId),
      )).run();
    }

    const updated = db.select().from(adminUsers).where(eq(adminUsers.id, user.id)).get()!;
    return { adminUsername: updated.username, masterKeyConfigured: true };
  });

  app.get(`${prefix}/screens`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    return db.select().from(screens).orderBy(desc(screens.createdAt)).all().map(screenJson);
  });
  app.post(`${prefix}/screens`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      const time = now(), row = {
        id: crypto.randomUUID(),
        ...parseScreen(request.body),
        timezone: "Asia/Shanghai",
        currentSnapshotId: null,
        createdAt: time,
        updatedAt: time,
      };
      db.insert(screens).values(row).run(); scheduleScreen(row);
      return reply.code(201).send(screenJson(row));
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.get(`${prefix}/screens/:screenId`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const row = db.select().from(screens).where(eq(screens.id, (request.params as Json).screenId as string)).get();
    return row ? screenJson(row) : fail(reply, 404);
  });
  app.put(`${prefix}/screens/:screenId`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const id = String((request.params as Json).screenId), existing = db.select().from(screens).where(eq(screens.id, id)).get();
    if (!existing) return fail(reply, 404);
    try {
      const values = parseScreen(request.body);
      if (values.colorMode !== existing.colorMode) {
        for (const widget of db.select().from(widgetInstances).where(eq(widgetInstances.screenId, id)).all()) {
          registry.validate(widget.widgetType, { ...widget.config }, values.colorMode);
        }
        for (const setting of db.select().from(screenPlugins).where(and(eq(screenPlugins.screenId, id), eq(screenPlugins.enabled, true))).all()) {
          if (!pluginSupportsColorMode(setting.pluginType, values.colorMode)) {
            throw new Error(`Enabled plugins have no style compatible with ${values.colorMode}: ${setting.pluginType}`);
          }
        }
      }
      const frameConfigChanged = values.panelLayout !== existing.panelLayout ||
        values.colorMode !== existing.colorMode ||
        values.width !== existing.width ||
        values.height !== existing.height;
      sqlite.transaction(() => {
        db.update(screens).set({
          ...values,
          ...(frameConfigChanged ? { currentSnapshotId: null } : {}),
          updatedAt: now(),
        }).where(eq(screens.id, id)).run();
        if (frameConfigChanged) {
          db.delete(snapshots).where(eq(snapshots.screenId, id)).run();
        }
      })();
      if (frameConfigChanged) {
        await rm(join(config.snapshotDir, id), { recursive: true, force: true });
      }
      const row = db.select().from(screens).where(eq(screens.id, id)).get()!; scheduleScreen(row);
      return screenJson(row);
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.delete(`${prefix}/screens/:screenId`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const id = String((request.params as Json).screenId);
    if (!db.select().from(screens).where(eq(screens.id, id)).get()) return fail(reply, 404);
    unscheduleScreen(id); db.delete(screens).where(eq(screens.id, id)).run();
    await rm(join(config.snapshotDir, id), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.post(`${prefix}/screens/:screenId/keys`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const screenId = String((request.params as Json).screenId);
    if (!db.select().from(screens).where(eq(screens.id, screenId)).get()) return fail(reply, 404);
    const key = makeApiKey(), id = crypto.randomUUID();
    db.insert(deviceCredentials).values({ id, screenId, keyPrefix: key.prefix, keyHash: key.digest, createdAt: now(), revokedAt: null }).run();
    return reply.code(201).send({ id, api_key: key.raw, key_prefix: key.prefix });
  });
  app.delete(`${prefix}/screens/:screenId/keys/:keyId`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json;
    const key = db.select().from(deviceCredentials).where(and(eq(deviceCredentials.id, String(params.keyId)), eq(deviceCredentials.screenId, String(params.screenId)))).get();
    if (!key) return fail(reply, 404);
    db.update(deviceCredentials).set({ revokedAt: now() }).where(eq(deviceCredentials.id, key.id)).run();
    return reply.code(204).send();
  });

  app.get(`${prefix}/widgets/catalog`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return; return registry.metadata();
  });
  app.get(`${prefix}/plugins`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    return db.select().from(pluginPackages).orderBy(asc(pluginPackages.typeName)).all().map((row) => pluginJson(row));
  });
  app.get(`${prefix}/plugins/:pluginType/styles/:styleId/source`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json;
    try {
      return await registry.source(String(params.pluginType), String(params.styleId));
    } catch (error) { return fail(reply, String(error).includes("Unknown") ? 404 : 422, String(error)); }
  });
  app.put(`${prefix}/plugins/:pluginType/styles/:styleId/source/draft`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json;
    try {
      return await registry.saveDraft(String(params.pluginType), String(params.styleId), request.body);
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.delete(`${prefix}/plugins/:pluginType/styles/:styleId/source/draft`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json;
    try {
      return await registry.discardDraft(String(params.pluginType), String(params.styleId));
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.post(`${prefix}/plugins/:pluginType/styles/:styleId/source/publish`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json;
    try {
      const type = String(params.pluginType);
      const result = await registry.saveRepositoryStyle(
        type,
        String(params.styleId),
        request.body,
      );
      syncPluginMetadata(type);
      return result;
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.post(`${prefix}/plugins/:pluginType/styles/:styleId/source/restore`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json;
    try {
      const type = String(params.pluginType);
      const result = await registry.restore(type, String(params.styleId));
      syncPluginMetadata(type);
      return result;
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.post(`${prefix}/plugins/:pluginType/styles/:styleId/clone`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json, type = String(params.pluginType);
    try {
      const metadata = await registry.cloneStyle(type, String(params.styleId), request.body);
      db.update(pluginPackages).set({ pluginMetadata: metadata, updatedAt: now() })
        .where(eq(pluginPackages.typeName, type)).run();
      return metadata;
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.get(`${prefix}/plugins/:pluginType/data/source`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      return await registry.dataSource(String((request.params as Json).pluginType));
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.put(`${prefix}/plugins/:pluginType/data/source/draft`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      return await registry.saveDataDraft(String((request.params as Json).pluginType), request.body);
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.delete(`${prefix}/plugins/:pluginType/data/source/draft`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      return await registry.discardDataDraft(String((request.params as Json).pluginType));
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.post(`${prefix}/plugins/:pluginType/data/source/publish`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const body = request.body === undefined ? undefined : object(request.body);
    try {
      return await registry.publishData(
        String((request.params as Json).pluginType),
        body && Object.keys(body).length ? body : undefined,
      );
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.post(`${prefix}/plugins/:pluginType/data/source/restore`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      return await registry.restoreData(String((request.params as Json).pluginType));
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.post(`${prefix}/plugins/:pluginType/data/adapt`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const type = String((request.params as Json).pluginType), body = object(request.body);
    try {
      const plugin = registry.get(type);
      const source = body.source === undefined
        ? (await registry.dataSource(type)).source
        : String(body.source);
      const configValue = registry.validate(type, {
        ...plugin.manifest.mockConfig,
        ...object(body.config),
      });
      const data = await runDataSource({
        type,
        manifest: plugin.manifest,
        source,
        config: configValue,
        operation: "adapt",
        input: body.input ?? plugin.manifest.mockData,
        options: { persist: false, strict: true, locale: "zh-CN", timeoutMs: 25_000 },
      });
      return { data };
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.post(`${prefix}/plugins/:pluginType/data/test`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const type = String((request.params as Json).pluginType), body = object(request.body);
    try {
      const plugin = registry.get(type);
      const source = body.source === undefined
        ? (await registry.dataSource(type)).source
        : String(body.source);
      const configValue = registry.validate(type, {
        ...plugin.manifest.mockConfig,
        ...object(body.config),
      });
      const data = await runDataSource({
        type,
        manifest: plugin.manifest,
        source,
        config: configValue,
        operation: "all",
        options: { persist: false, strict: true, locale: "zh-CN", timeoutMs: 25_000 },
      });
      return { data };
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.get(`${prefix}/screens/:screenId/plugins`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const screenId = String((request.params as Json).screenId);
    const screen = db.select().from(screens).where(eq(screens.id, screenId)).get(); if (!screen) return fail(reply, 404);
    const settings = new Map(db.select().from(screenPlugins).where(eq(screenPlugins.screenId, screenId)).all().map((row) => [row.pluginType, row.enabled]));
    return db.select().from(pluginPackages).orderBy(asc(pluginPackages.typeName)).all().map((row) => {
      const compatible = pluginSupportsColorMode(row.typeName, screen.colorMode);
      return pluginJson(row, settings.get(row.typeName) ?? (row.status === "available" && compatible));
    });
  });
  app.put(`${prefix}/screens/:screenId/plugins/:pluginType`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json, screenId = String(params.screenId), pluginType = String(params.pluginType);
    const screen = db.select().from(screens).where(eq(screens.id, screenId)).get();
    const plugin = db.select().from(pluginPackages).where(eq(pluginPackages.typeName, pluginType)).get();
    if (!screen || !plugin) return fail(reply, 404);
    const enabledValue = object(request.body).enabled;
    if (typeof enabledValue !== "boolean") return fail(reply, 422, "enabled must be a boolean");
    const enabled = enabledValue;
    if (enabled && plugin.status !== "available") return fail(reply, 409, "Plugin is not available");
    if (enabled) {
      if (!pluginSupportsColorMode(pluginType, screen.colorMode)) {
        return fail(reply, 409, `Plugin ${pluginType} has no style compatible with ${screen.colorMode}`);
      }
    }
    const time = now(), existing = db.select().from(screenPlugins).where(and(eq(screenPlugins.screenId, screenId), eq(screenPlugins.pluginType, pluginType))).get();
    if (existing) db.update(screenPlugins).set({ enabled, updatedAt: time }).where(and(eq(screenPlugins.screenId, screenId), eq(screenPlugins.pluginType, pluginType))).run();
    else db.insert(screenPlugins).values({ screenId, pluginType, enabled, createdAt: time, updatedAt: time }).run();
    return pluginJson(plugin, enabled);
  });

  app.get(`${prefix}/screens/:screenId/widgets`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    return db.select().from(widgetInstances).where(eq(widgetInstances.screenId, String((request.params as Json).screenId))).orderBy(asc(widgetInstances.zIndex)).all().map(widgetJson);
  });
  app.post(`${prefix}/screens/:screenId/widgets`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const screen = db.select().from(screens).where(eq(screens.id, String((request.params as Json).screenId))).get(); if (!screen) return fail(reply, 404);
    try { const row = parseWidget(request.body, screen); db.insert(widgetInstances).values(row).run(); return reply.code(201).send(widgetJson(row)); }
    catch (error) { return fail(reply, 422, String(error)); }
  });
  app.put(`${prefix}/screens/:screenId/widgets`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const screenId = String((request.params as Json).screenId), screen = db.select().from(screens).where(eq(screens.id, screenId)).get(); if (!screen) return fail(reply, 404);
    if (!Array.isArray(request.body)) return fail(reply, 422, "Expected widget list");
    const existing = new Map(db.select().from(widgetInstances).where(eq(widgetInstances.screenId, screenId)).all().map((row) => [row.id, row]));
    try {
      const rows = request.body.map((item) => {
        const value = object(item), requestedId = typeof value.id === "string" ? value.id : undefined;
        if (requestedId && !existing.has(requestedId)) throw new Error("Layout contains stale widget IDs");
        const parsed = parseWidget(value, screen, requestedId);
        const old = requestedId ? existing.get(requestedId) : undefined;
        return { ...parsed, configVersion: old ? old.configVersion + 1 : 1, createdAt: old?.createdAt ?? parsed.createdAt };
      });
      sqlite.transaction(() => {
        db.delete(widgetInstances).where(eq(widgetInstances.screenId, screenId)).run();
        if (rows.length) db.insert(widgetInstances).values(rows).run();
      })();
      return rows.map(widgetJson);
    } catch (error) { return fail(reply, String(error).includes("stale") ? 409 : 422, String(error)); }
  });
  app.put(`${prefix}/screens/:screenId/widgets/:widgetId`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json, screen = db.select().from(screens).where(eq(screens.id, String(params.screenId))).get();
    const old = db.select().from(widgetInstances).where(and(eq(widgetInstances.id, String(params.widgetId)), eq(widgetInstances.screenId, String(params.screenId)))).get();
    if (!screen || !old) return fail(reply, 404);
    try {
      const row = { ...parseWidget(request.body, screen, old.id), createdAt: old.createdAt, configVersion: old.configVersion + 1 };
      db.update(widgetInstances).set(row).where(eq(widgetInstances.id, old.id)).run(); return widgetJson(row);
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.delete(`${prefix}/screens/:screenId/widgets/:widgetId`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const params = request.params as Json, condition = and(eq(widgetInstances.id, String(params.widgetId)), eq(widgetInstances.screenId, String(params.screenId)));
    if (!db.select().from(widgetInstances).where(condition).get()) return fail(reply, 404);
    db.delete(widgetInstances).where(condition).run(); return reply.code(204).send();
  });

  app.post(`${prefix}/screens/:screenId/render`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const id = String((request.params as Json).screenId), screen = db.select().from(screens).where(eq(screens.id, id)).get(); if (!screen) return fail(reply, 404);
    const dataSource = object(request.body).data_source;
    if (dataSource !== undefined && dataSource !== "mock" && dataSource !== "real") return fail(reply, 422, "Invalid data source");
    const forceMock = dataSource === "mock", warnings: string[] = [];
    if (!forceMock) {
      const widgets = db.select().from(widgetInstances).where(eq(widgetInstances.screenId, id)).all();
      await composeScreen(screen, widgets, { warnings, strict: true });
    }
    try {
      const snapshotId = await renderScreen(id, forceMock);
      const latest = db.select().from(screens).where(eq(screens.id, id)).get();
      return {
        queued: false,
        warnings,
        snapshot_id: snapshotId ?? latest?.currentSnapshotId ?? null,
      };
    } catch (error) {
      app.log.error(error);
      return fail(reply, 500, String(error));
    }
  });
  app.post(`${prefix}/screens/:screenId/draft-preview`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const id = String((request.params as Json).screenId), screen = db.select().from(screens).where(eq(screens.id, id)).get(); if (!screen) return fail(reply, 404);
    const body = object(request.body), drafts = Array.isArray(body.widgets) ? body.widgets : [];
    try {
      if (body.widgets !== undefined && !Array.isArray(body.widgets)) throw new Error("Expected widget list");
      if (body.mode !== undefined && body.mode !== "source" && body.mode !== "device") throw new Error("Invalid preview mode");
      if (body.data_source !== undefined && body.data_source !== "mock" && body.data_source !== "real") throw new Error("Invalid data source");
      const forceMock = body.data_source === "mock";
      const widgets = drafts.map((item) => parseWidget(item, screen, crypto.randomUUID(), forceMock));
      const result = await renderDraft(screen, widgets, { forceMock, allowMock: true, device: body.mode !== "source" });
      const dataMode = result.modes.every((mode) => mode === "real") ? "real" : result.modes.every((mode) => mode === "mock") ? "mock" : "mixed";
      return reply.type("image/png").header("X-EPD-Data-Mode", dataMode).send(result.png);
    } catch (error) { return fail(reply, 422, String(error)); }
  });
  app.post(`${prefix}/screens/:screenId/widget-preview`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const screen = db.select().from(screens).where(eq(screens.id, String((request.params as Json).screenId))).get(); if (!screen) return fail(reply, 404);
    try {
      const body = object(request.body);
      const sourceOverride = body.source_override === undefined
        ? undefined
        : registry.validateSource(body.source_override);
      const manifestTest = body.manifest_test === true;
      const widgetType = String(body.widget_type ?? "");
      const plugin = registry.get(widgetType);
      const styleId = String(object(body.config).style_id ?? plugin.manifest.defaultStyle);
      const style = plugin.styles.get(styleId);
      if (!style) throw new Error(`Unknown style '${styleId}' for widget ${widgetType}`);
      const testManifest = body.style_manifest_override === undefined
        ? { id: style.id, title: style.title, defaultSize: style.defaultSize, requiredColors: style.requiredColors }
        : registry.validateStyleManifest(body.style_manifest_override, styleId);
      const missingColors = testManifest.requiredColors.filter((color) => !availableColors(screen.colorMode).has(color));
      if (missingColors.length) {
        throw new Error(`Style '${styleId}' requires colors unavailable on ${screen.colorMode}: ${missingColors.join(", ")}`);
      }
      const widgetBody = manifestTest
        ? {
            ...body,
            x: 0,
            y: 0,
            width: Math.min(testManifest.defaultSize.width, screen.width),
            height: Math.min(testManifest.defaultSize.height, screen.height),
          }
        : body;
      const testColorMode = testManifest.requiredColors.some((color) => color === "red" || color === "yellow")
        ? screen.colorMode
        : "bw";
      return reply
        .type("image/png")
        .header("X-EPD-Test-Width", String(widgetBody.width))
        .header("X-EPD-Test-Height", String(widgetBody.height))
        .header("X-EPD-Test-Color-Mode", manifestTest ? testColorMode : screen.colorMode)
        .send(await renderWidgetPreview(
        screen,
        parseWidget(widgetBody, screen, crypto.randomUUID(), true),
        sourceOverride,
        body.data_override,
        manifestTest ? testManifest : undefined,
      ));
    }
    catch (error) { return fail(reply, 422, String(error)); }
  });
  app.get(`${prefix}/screens/:screenId/preview`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const screen = db.select().from(screens).where(eq(screens.id, String((request.params as Json).screenId))).get();
    if (!screen?.currentSnapshotId) return fail(reply, 404, "No rendered snapshot");
    const snapshot = db.select().from(snapshots).where(eq(snapshots.id, screen.currentSnapshotId)).get(); if (!snapshot) return fail(reply, 404);
    const mode = String((request.query as Json).mode ?? "device");
    if (mode === "source" || mode === "device") return reply.type("image/png").send(await readFile(mode === "source" ? snapshot.sourcePath : snapshot.previewPath));
    if (mode !== "diff") return fail(reply, 422);
    const regions = db.select().from(snapshotRegions).where(eq(snapshotRegions.snapshotId, snapshot.id)).all();
    let image = sharp(await readFile(snapshot.previewPath));
    const composites = regions.map((region) => ({
      input: Buffer.from(`<svg width="${region.width}" height="${region.height}"><rect x="1" y="1" width="${region.width - 2}" height="${region.height - 2}" fill="none" stroke="red" stroke-width="2"/></svg>`),
      left: region.x, top: region.y,
    }));
    if (composites.length) image = image.composite(composites);
    return reply.type("image/png").send(await image.png().toBuffer());
  });

  app.get(`${prefix}/secrets`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    return db.select().from(secrets).orderBy(asc(secrets.name)).all().map((row) => ({ id: row.id, name: row.name, purpose: row.purpose, updated_at: row.updatedAt }));
  });
  app.post(`${prefix}/secrets/qweather/keypair`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    return generateEd25519KeyPairPem();
  });
  app.get(`${prefix}/secrets/:secretId/public-key`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const id = String((request.params as Json).secretId);
    const row = db.select().from(secrets).where(eq(secrets.id, id)).get();
    if (!row) return fail(reply, 404);
    if (row.purpose !== "qweather_jwt") return fail(reply, 422, "Public key is only available for QWeather JWT secrets");
    try {
      return { publicKey: publicKeyPemFromPrivateKeyPem(decryptSecret(row.encryptedValue)) };
    } catch (error) {
      return fail(reply, 422, error instanceof Error ? error.message : "Failed to derive public key");
    }
  });
  app.post(`${prefix}/secrets`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const body = object(request.body), name = String(body.name ?? ""), purpose = String(body.purpose ?? ""), value = String(body.value ?? "");
    if (!name || !purpose || !value) return fail(reply, 422, "Secret fields must not be empty");
    if (!secretPurposes.has(purpose)) return fail(reply, 422, "Unsupported secret purpose");
    if (purpose === "qweather_jwt") {
      try {
        publicKeyPemFromPrivateKeyPem(value);
      } catch (error) {
        return fail(reply, 422, error instanceof Error ? error.message : "Invalid Ed25519 private key PEM");
      }
    }
    const old = db.select().from(secrets).where(eq(secrets.name, name)).get(), time = now();
    if (old) db.update(secrets).set({ purpose, encryptedValue: encryptSecret(value), updatedAt: time }).where(eq(secrets.id, old.id)).run();
    else db.insert(secrets).values({ id: crypto.randomUUID(), name, purpose, encryptedValue: encryptSecret(value), createdAt: time, updatedAt: time }).run();
    const row = db.select().from(secrets).where(eq(secrets.name, name)).get()!;
    return { id: row.id, name: row.name, purpose: row.purpose, updated_at: row.updatedAt };
  });
  app.delete(`${prefix}/secrets/:secretId`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const id = String((request.params as Json).secretId);
    if (!db.select().from(secrets).where(eq(secrets.id, id)).get()) return fail(reply, 404);
    db.delete(secrets).where(eq(secrets.id, id)).run();
    db.delete(providerStates).where(eq(providerStates.cacheKey, `cursor:current-period:${id}`)).run();
    return reply.code(204).send();
  });
  app.get(`${prefix}/providers/status`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    pruneUnreferencedProviderStates();
    return db.select().from(providerStates).orderBy(asc(providerStates.cacheKey)).all().map((row) => ({
      cacheKey: row.cacheKey, lastSuccessAt: row.lastSuccessAt, lastError: row.lastError, expiresAt: row.expiresAt,
    }));
  });

  app.get(`${prefix}/screens/:screenId/export`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const id = String((request.params as Json).screenId), screen = db.select().from(screens).where(eq(screens.id, id)).get(); if (!screen) return fail(reply, 404);
    const widgets = db.select().from(widgetInstances).where(eq(widgetInstances.screenId, id)).orderBy(asc(widgetInstances.zIndex)).all();
    const settings = new Map(db.select().from(screenPlugins).where(eq(screenPlugins.screenId, id)).all().map((row) => [row.pluginType, row.enabled]));
    const plugins = Object.fromEntries(db.select().from(pluginPackages).where(eq(pluginPackages.status, "available")).all().map((row) => [row.typeName, settings.get(row.typeName) ?? true]));
    const screenBody = screenJson(screen); for (const key of ["id", "current_snapshot_id", "available_colors", "created_at", "updated_at"]) delete screenBody[key];
    return { format: "epdserver-screen", version: 1, exported_at: now(), screen: screenBody, plugins, widgets: widgets.map((row) => { const value = widgetJson(row); for (const key of ["id", "screen_id", "config_version"]) delete value[key]; return value; }) };
  });

  async function importDocument(request: FastifyRequest, reply: FastifyReply, overwriteId?: string): Promise<unknown> {
    const document = object(request.body);
    try {
      if (document.format !== undefined && document.format !== "epdserver-screen") {
        throw new Error("Invalid screen document format");
      }
      if (document.version !== undefined && document.version !== 1) {
        throw new Error("Unsupported screen document version");
      }
      if (document.widgets !== undefined && !Array.isArray(document.widgets)) {
        throw new Error("Invalid screen document widgets");
      }
      if (document.plugins !== undefined && (
        !document.plugins || typeof document.plugins !== "object" || Array.isArray(document.plugins)
      )) {
        throw new Error("Invalid screen document plugins");
      }
      const values = parseScreen(document.screen, true), time = now();
      const existing = overwriteId ? db.select().from(screens).where(eq(screens.id, overwriteId)).get() : undefined;
      if (overwriteId && !existing) return fail(reply, 404);
      const row: Screen = existing
        ? { ...existing, ...values, currentSnapshotId: null, updatedAt: time }
        : {
          id: crypto.randomUUID(),
          ...values,
          timezone: "Asia/Shanghai",
          currentSnapshotId: null,
          createdAt: time,
          updatedAt: time,
        };
      const widgetsBody = Array.isArray(document.widgets) ? document.widgets : [];
      const widgetRows = widgetsBody.map((item) => parseWidget(item, row));
      const pluginBody = object(document.plugins);
      for (const [type, enabled] of Object.entries(pluginBody)) {
        const plugin = db.select().from(pluginPackages).where(eq(pluginPackages.typeName, type)).get();
        if (!plugin || plugin.status !== "available") throw new Error(`Plugin is not available: ${type}`);
        if (typeof enabled !== "boolean") throw new Error(`Invalid plugin setting: ${type}`);
        if (enabled && !pluginSupportsColorMode(type, row.colorMode)) {
          throw new Error(`Plugin ${type} has no style compatible with ${row.colorMode}`);
        }
      }
      sqlite.transaction(() => {
        if (existing) {
          db.update(screens).set(row).where(eq(screens.id, row.id)).run();
          db.delete(widgetInstances).where(eq(widgetInstances.screenId, row.id)).run();
          db.delete(screenPlugins).where(eq(screenPlugins.screenId, row.id)).run();
          db.delete(snapshots).where(eq(snapshots.screenId, row.id)).run();
        } else db.insert(screens).values(row).run();
        if (widgetRows.length) db.insert(widgetInstances).values(widgetRows).run();
        for (const [type, enabled] of Object.entries(pluginBody)) db.insert(screenPlugins).values({ screenId: row.id, pluginType: type, enabled: enabled as boolean, createdAt: time, updatedAt: time }).run();
      })();
      if (existing) await rm(join(config.snapshotDir, row.id), { recursive: true, force: true });
      scheduleScreen(row);
      return overwriteId ? screenJson(row) : reply.code(201).send(screenJson(row));
    } catch (error) { return fail(reply, 422, String(error)); }
  }
  app.post(`${prefix}/screens/import`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return; return importDocument(request, reply);
  });
  app.put(`${prefix}/screens/:screenId/import`, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return; return importDocument(request, reply, String((request.params as Json).screenId));
  });
};
