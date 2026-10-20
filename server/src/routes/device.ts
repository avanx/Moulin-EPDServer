import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { deviceCredentials, renderMetrics, screens, snapshotRegions, snapshots } from "../db/schema.js";
import { screenHasClock, renderScreen } from "../scheduler.js";
import { apiKeyPrefix, verifyApiKey } from "../security.js";
import { isSilentAt, secondsUntilSilentEnd } from "../silent-time.js";

type Json = Record<string, unknown>;
const attempts = new Map<string, number[]>();
const RENDER_LEAD_FALLBACK_MS = 5_000;
const MAX_DISPLAY_LATENCY_MS = 86_400_000;

function reportedDisplayLatencyMs(value: unknown): number | null {
  const text = Array.isArray(value) ? value[0] : value;
  const parsed = typeof text === "string" ? Number(text) : typeof text === "number" ? text : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_DISPLAY_LATENCY_MS) return null;
  return parsed;
}

function latestRenderDurationMs(screenId: string): number {
  const row = db.select().from(renderMetrics).where(eq(renderMetrics.screenId, screenId))
    .orderBy(desc(renderMetrics.createdAt)).get();
  if (!row || !Number.isFinite(row.durationMs) || row.durationMs < 0) return RENDER_LEAD_FALLBACK_MS;
  return row.durationMs;
}

function fail(reply: FastifyReply, status: number, detail?: string): FastifyReply {
  return reply.code(status).send(detail ? { detail } : {});
}

function authorize(request: FastifyRequest, reply: FastifyReply, screenId: string): boolean {
  const raw = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : "";
  if (!raw) { fail(reply, 401); return false; }
  const prefix = apiKeyPrefix(raw);
  const rows = db.select().from(deviceCredentials).where(and(
    eq(deviceCredentials.screenId, screenId), eq(deviceCredentials.keyPrefix, prefix),
  )).all();
  const credential = rows.find((item) => item.revokedAt === null && verifyApiKey(raw, item.keyHash));
  if (!credential) { fail(reply, 401); return false; }
  const cutoff = Date.now() - 60_000;
  const recent = (attempts.get(prefix) ?? []).filter((item) => item >= cutoff);
  if (recent.length >= 120) { fail(reply, 429); return false; }
  recent.push(Date.now()); attempts.set(prefix, recent);
  return true;
}

async function sendBinary(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  digest: string,
  filename: string,
): Promise<FastifyReply> {
  let info;
  try { info = await stat(path); } catch { return fail(reply, 404); }
  reply.header("ETag", `"${digest}"`)
    .header("Cache-Control", "private, immutable, max-age=31536000")
    .header("X-Content-SHA256", digest)
    .header("Accept-Ranges", "bytes")
    .header("Content-Type", "application/octet-stream")
    .header("Content-Disposition", `attachment; filename="${filename}"`);
  const range = request.headers.range;
  if (!range) {
    reply.header("Content-Length", info.size);
    return reply.send(createReadStream(path));
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return reply.code(416).header("Content-Range", `bytes */${info.size}`).send();
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return reply.code(416).header("Content-Range", `bytes */${info.size}`).send();
    start = Math.max(0, info.size - suffix); end = info.size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : info.size - 1;
  }
  if (start < 0 || start >= info.size || end < start) return reply.code(416).header("Content-Range", `bytes */${info.size}`).send();
  end = Math.min(end, info.size - 1);
  reply.code(206).header("Content-Range", `bytes ${start}-${end}/${info.size}`).header("Content-Length", end - start + 1);
  return reply.send(createReadStream(path, { start, end }));
}

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  const prefix = "/api/v1/device/screens/:screenId";
  app.get(`${prefix}/manifest`, async (request, reply) => {
    const params = request.params as Json, screenId = String(params.screenId);
    if (!authorize(request, reply, screenId)) return;
    const screen = db.select().from(screens).where(eq(screens.id, screenId)).get();
    if (!screen?.enabled) return fail(reply, 404, "No snapshot available");
    const query = request.query as Json;
    const silentActive = isSilentAt(screen);
    let active = screen;
    if (!silentActive && screenHasClock(screen.id)) {
      const reported = reportedDisplayLatencyMs(query.display_latency_ms);
      const latencyMs = reported ?? Math.max(0, screen.panelLatencySeconds) * 1000;
      const clockAt = new Date(Date.now() + latencyMs + latestRenderDurationMs(screen.id)).toISOString();
      await renderScreen(screen.id, false, { clockAt });
      const refreshed = db.select().from(screens).where(eq(screens.id, screen.id)).get();
      if (!refreshed?.enabled || !refreshed.currentSnapshotId) return fail(reply, 404, "No snapshot available");
      active = refreshed;
    } else if (!screen.currentSnapshotId) {
      return fail(reply, 404, "No snapshot available");
    }
    const snapshot = db.select().from(snapshots).where(eq(snapshots.id, active.currentSnapshotId!)).get();
    if (!snapshot) return fail(reply, 404);
    const base = typeof query.base_snapshot_id === "string" ? query.base_snapshot_id : null;
    const ifNoneMatch = String(request.headers["if-none-match"] ?? "").replaceAll('"', "");
    const refreshAfterSeconds = silentActive ? secondsUntilSilentEnd(active) : active.refreshSeconds;
    reply.header("ETag", `"${snapshot.id}"`).header("Cache-Control", "private, no-cache");
    if (ifNoneMatch === snapshot.id || base === snapshot.id) {
      return reply.header("Retry-After", String(refreshAfterSeconds)).code(304).send();
    }
    const canPartial = active.colorMode === "bw" && base !== null && base === snapshot.baseSnapshotId;
    const stored = canPartial ? db.select().from(snapshotRegions).where(eq(snapshotRegions.snapshotId, snapshot.id)).all() : [];
    const origin = `${request.protocol}://${request.headers.host}`;
    const frameUrl = `${origin}/api/v1/device/screens/${screenId}/snapshots/${snapshot.id}/frame`;
    const regions = stored.map((item) => {
      const planeByteSize = item.stride * item.height;
      return {
        id: item.id, x: item.x, y: item.y, width: item.width, height: item.height,
        stride: item.stride, plane_byte_size: planeByteSize, byte_size: item.byteSize,
        sha256: item.sha256,
        url: `${origin}/api/v1/device/screens/${screenId}/snapshots/${snapshot.id}/regions/${item.id}`,
      };
    });
    return {
      screen_id: active.id, snapshot_id: snapshot.id, base_snapshot_id: snapshot.baseSnapshotId,
      update_type: regions.length ? "partial" : "full", width: active.width, height: active.height,
      color_mode: active.colorMode, panel_layout: active.panelLayout,
      encoding: snapshot.encoding, refresh_after_seconds: refreshAfterSeconds, silent_active: silentActive,
      byte_size: snapshot.byteSize, sha256: snapshot.sha256, frame_url: frameUrl, regions,
    };
  });
  app.get(`${prefix}/snapshots/:snapshotId/frame`, async (request, reply) => {
    const params = request.params as Json, screenId = String(params.screenId);
    if (!authorize(request, reply, screenId)) return;
    const snapshot = db.select().from(snapshots).where(and(eq(snapshots.id, String(params.snapshotId)), eq(snapshots.screenId, screenId))).get();
    if (!snapshot) return fail(reply, 404);
    return sendBinary(request, reply, snapshot.framePath, snapshot.sha256, `${snapshot.id}.bin`);
  });
  app.get(`${prefix}/snapshots/:snapshotId/regions/:regionId`, async (request, reply) => {
    const params = request.params as Json, screenId = String(params.screenId), snapshotId = String(params.snapshotId);
    if (!authorize(request, reply, screenId)) return;
    const snapshot = db.select().from(snapshots).where(and(eq(snapshots.id, snapshotId), eq(snapshots.screenId, screenId))).get();
    const region = db.select().from(snapshotRegions).where(and(eq(snapshotRegions.id, String(params.regionId)), eq(snapshotRegions.snapshotId, snapshotId))).get();
    if (!snapshot || !region) return fail(reply, 404);
    return sendBinary(request, reply, region.path, region.sha256, `${region.id}.bin`);
  });
};
