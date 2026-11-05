import { and, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { sharedDataSources } from "../db/schema.js";
import { databaseTimestampMillis } from "../security.js";
import { runDataSource } from "./data-runner.js";
import { registry } from "./registry.js";

export type SharedDataSource = typeof sharedDataSources.$inferSelect;

/** One in-flight fetch per shared data source, so concurrent screen renders share a single request. */
const inflight = new Map<string, Promise<unknown>>();

function future(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function stripMarkers(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const { _stale: _ignoredStale, _error: _ignoredError, ...rest } = value as Record<string, unknown>;
  return rest;
}

function isAfterNow(value: string | null): boolean {
  return Boolean(value) && databaseTimestampMillis(value!) > Date.now();
}

/** Refresh interval: the source's own cache_minutes, falling back to the manifest's cacheSeconds. */
export function sharedRefreshSeconds(source: Pick<SharedDataSource, "widgetType" | "config">): number {
  const minutes = Number(source.config.cache_minutes);
  if (Number.isFinite(minutes) && minutes > 0) return Math.round(minutes * 60);
  return registry.get(source.widgetType).manifest.externalData?.cacheSeconds ?? 900;
}

function sharedStaleSeconds(source: Pick<SharedDataSource, "widgetType" | "config">): number {
  const refresh = sharedRefreshSeconds(source);
  const stale = registry.get(source.widgetType).manifest.externalData?.staleSeconds ?? refresh;
  return Math.max(refresh, stale);
}

export function loadSharedSource(id: string, ownerId: string): SharedDataSource | undefined {
  return db.select().from(sharedDataSources)
    .where(and(eq(sharedDataSources.id, id), eq(sharedDataSources.ownerId, ownerId)))
    .get();
}

function requireSharedSource(id: string, ownerId: string): SharedDataSource {
  const row = loadSharedSource(id, ownerId);
  if (!row) throw new Error(`Shared data source not found: ${id}`);
  return row;
}

async function fetchShared(id: string, ownerId: string): Promise<unknown> {
  // Re-read: another caller may have refreshed the row while we were queued.
  const row = requireSharedSource(id, ownerId);
  if (row.payload && isAfterNow(row.expiresAt)) return row.payload;
  const plugin = registry.get(row.widgetType);
  try {
    const value = await runDataSource({
      type: row.widgetType,
      manifest: plugin.manifest,
      source: plugin.dataSource,
      config: registry.validateShared(row.widgetType, { ...row.config }),
      operation: "fetch",
      options: { ownerId, bypassProviderCache: true, locale: "zh-CN" },
    });
    const payload = stripMarkers(value);
    db.update(sharedDataSources).set({
      payload,
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
      expiresAt: future(sharedRefreshSeconds(row)),
      staleUntil: future(sharedStaleSeconds(row)),
    }).where(eq(sharedDataSources.id, row.id)).run();
    return payload;
  } catch (error) {
    db.update(sharedDataSources).set({ lastError: String(error).slice(0, 500) })
      .where(eq(sharedDataSources.id, row.id)).run();
    if (row.payload && isAfterNow(row.staleUntil)) {
      return { ...row.payload, _stale: true, _error: String(error) };
    }
    throw error;
  }
}

/**
 * Returns the raw (pre-adaptData) payload of a shared data source. Fresh data is served from the
 * database; expired data triggers one fetch that every concurrent caller waits on.
 */
export async function readSharedSource(id: string, ownerId: string): Promise<unknown> {
  const row = requireSharedSource(id, ownerId);
  if (row.payload && isAfterNow(row.expiresAt)) return row.payload;
  const pending = inflight.get(id);
  if (pending) return pending;
  const created = fetchShared(id, ownerId).finally(() => inflight.delete(id));
  inflight.set(id, created);
  return created;
}

/** Widget config with the shared source's fields applied on top. */
export function mergeSharedConfig(
  widgetConfig: Record<string, unknown>,
  source: Pick<SharedDataSource, "widgetType" | "config">,
): Record<string, unknown> {
  return { ...widgetConfig, ...registry.validateShared(source.widgetType, { ...source.config }) };
}

/** Effective config for a widget bound to a shared data source. */
export function effectiveWidgetConfig(
  widget: { widgetType: string; config: Record<string, unknown>; dataSourceId: string | null },
  ownerId: string,
): Record<string, unknown> {
  if (!widget.dataSourceId) return widget.config;
  const source = requireSharedSource(widget.dataSourceId, ownerId);
  if (source.widgetType !== widget.widgetType) {
    throw new Error("Shared data source belongs to a different widget type");
  }
  return mergeSharedConfig(widget.config, source);
}

/** Forces the next read of matching sources to fetch again. */
export function expireSharedSources(predicate: (row: SharedDataSource) => boolean): void {
  for (const row of db.select().from(sharedDataSources).all()) {
    if (!predicate(row)) continue;
    db.update(sharedDataSources).set({ expiresAt: null }).where(eq(sharedDataSources.id, row.id)).run();
  }
}

/** Expires every source of this owner whose config references the given secret id or name. */
export function expireSharedSourcesUsingSecret(ownerId: string, refs: string[]): void {
  const values = new Set(refs.filter(Boolean));
  expireSharedSources((row) => {
    if (row.ownerId !== ownerId) return false;
    let field: string | undefined;
    try {
      field = registry.get(row.widgetType).manifest.externalData?.secretConfigField;
    } catch {
      field = undefined;
    }
    return Object.entries(row.config).some(([key, value]) =>
      typeof value === "string" && values.has(value) && (key === field || key.endsWith("secret_id")));
  });
}
