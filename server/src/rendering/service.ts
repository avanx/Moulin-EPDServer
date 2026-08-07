import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { and, asc, eq } from "drizzle-orm";
import sharp from "sharp";

import { config } from "../config.js";
import { db, sqlite } from "../db/index.js";
import {
  renderMetrics, screens, snapshotRegions, snapshots, widgetInstances,
} from "../db/schema.js";
import { databaseTimestampMillis } from "../security.js";
import { runDataSource } from "../widgets/data-runner.js";
import { registry, type WidgetSource, type WidgetStyleManifest } from "../widgets/registry.js";
import { BrowserPool } from "./browser-pool.js";
import { composeScreenHtml } from "./compose.js";
import { encodeDirtyBwRegions } from "./dirty-region.js";
import { HtmlRenderer } from "./html-renderer.js";
import { prepareFrame } from "./pipeline.js";
import { quantizeBw } from "./quantize.js";
import { removeSnapshotDirectories, sha256Hex, writeSnapshotAtomically } from "./snapshots.js";
import type { EncodedDirtyRegion } from "./types.js";

type Screen = typeof screens.$inferSelect;
type Widget = typeof widgetInstances.$inferSelect;

const browserPool = new BrowserPool({ maxBrowsers: 1 });
const htmlRenderer = new HtmlRenderer(browserPool);

class RenderCache<T> {
  readonly #values = new Map<string, T>();
  readonly #pending = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries: number) {}

  async getOrCreate(key: string, create: () => Promise<T>): Promise<T> {
    const cached = this.#values.get(key);
    if (cached !== undefined) {
      this.#values.delete(key);
      this.#values.set(key, cached);
      return cached;
    }
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const created = create()
      .then((value) => {
        this.#values.set(key, value);
        while (this.#values.size > this.maxEntries) {
          const oldest = this.#values.keys().next().value;
          if (oldest === undefined) break;
          this.#values.delete(oldest);
        }
        return value;
      })
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, created);
    return created;
  }
}

const draftPreviewCache = new RenderCache<{ png: Buffer; modes: string[] }>(32);
const widgetPreviewCache = new RenderCache<Buffer>(128);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function widgetRenderRevision(widget: Pick<Widget, "widgetType" | "width" | "height" | "config">): unknown {
  const plugin = registry.get(widget.widgetType);
  const configValue = registry.validate(widget.widgetType, widget.config);
  const styleId = String(configValue.style_id ?? plugin.manifest.defaultStyle);
  const style = plugin.styles.get(styleId);
  return {
    type: widget.widgetType,
    width: widget.width,
    height: widget.height,
    config: configValue,
    manifest: plugin.manifest,
    dataSource: plugin.dataSource,
    style,
  };
}

function renderCacheKey(value: unknown): string {
  return sha256Hex(Buffer.from(stableJson(value)));
}

export async function closeRenderingService(): Promise<void> {
  await browserPool.close();
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function errorWidgetHtml(type: string, error: unknown): string {
  const message = `${type}: ${String(error)}`.slice(0, 120);
  return `<div style="width:100%;height:100%;padding:10px;border:2px solid #000;background:#fff;color:#000;font:12px Arial,sans-serif"><b style="display:block;margin-bottom:10px;font-size:16px">Widget error</b><span data-error></span></div><script>document.currentScript.previousElementSibling.querySelector("[data-error]").textContent=${safeJson(message)}</script>`;
}

async function widgetHtml(
  widget: Pick<Widget, "widgetType" | "width" | "height" | "config">,
  options: {
    forceMock?: boolean;
    allowMock?: boolean;
    strict?: boolean;
    warnings?: string[];
    sourceOverride?: WidgetSource;
    dataOverride?: unknown;
  } = {},
): Promise<{ html: string; mode: "real" | "mock" }> {
  const plugin = registry.get(widget.widgetType);
  const configValue = registry.validate(widget.widgetType, widget.config);
  let data: unknown;
  let mode: "real" | "mock" = "real";
  if (options.dataOverride !== undefined) {
    data = options.dataOverride;
    mode = "mock";
  } else if (options.forceMock) {
    data = await runDataSource({
      type: widget.widgetType,
      manifest: plugin.manifest,
      source: plugin.dataSource,
      config: configValue,
      operation: "adapt",
      input: plugin.manifest.mockData,
      options: { persist: false, locale: "zh-CN" },
    });
    mode = "mock";
  } else {
    try {
      data = await runDataSource({
        type: widget.widgetType,
        manifest: plugin.manifest,
        source: plugin.dataSource,
        config: configValue,
        operation: "all",
        options: {
          persist: !options.allowMock,
          locale: "zh-CN",
          ...(options.strict === undefined ? {} : { strict: options.strict }),
        },
      });
    } catch (error) {
      options.warnings?.push(`${widget.widgetType}: ${String(error)}`);
      if (!options.allowMock) {
        return { html: errorWidgetHtml(widget.widgetType, error), mode: "mock" };
      } else {
        data = await runDataSource({
          type: widget.widgetType,
          manifest: plugin.manifest,
          source: plugin.dataSource,
          config: configValue,
          operation: "adapt",
          input: plugin.manifest.mockData,
          options: { persist: false, locale: "zh-CN" },
        });
        mode = "mock";
      }
    }
  }
  const styleId = String(configValue.style_id ?? plugin.manifest.defaultStyle);
  const style = plugin.styles.get(styleId)!;
  const sourceCode = options.sourceOverride;
  const state = safeJson({ data, config: configValue, size: { width: widget.width, height: widget.height }, locale: "zh-CN" });
  const template = sourceCode?.template ?? style.template;
  const css = sourceCode?.style ?? style.css;
  const document = `<style>:host{display:block;width:100%;height:100%;color:#000;background:#fff;font-family:"Microsoft YaHei","Noto Sans CJK SC","Noto Sans",Arial,sans-serif}*,*::before,*::after{box-sizing:border-box}.epd-widget-root{position:relative;width:100%;height:100%;overflow:hidden}svg{display:block}${css}</style><div class="epd-widget-root">${template}</div>`;
  const html = `<div class="epd-widget-host" style="width:100%;height:100%"></div><script>(()=>{const container=document.currentScript.previousElementSibling;const shadow=container.attachShadow({mode:"open"});shadow.innerHTML=${safeJson(document)};const host=shadow.querySelector(".epd-widget-root");const state=${state};for(const node of host.querySelectorAll("[data-text]")){let value=state;for(const key of node.getAttribute("data-text").split("."))value=value==null?undefined:value[key];node.textContent=value==null?"":String(value)}for(const node of host.querySelectorAll("[data-class]")){let value=state;for(const key of node.getAttribute("data-class").split("."))value=value==null?undefined:value[key];if(typeof value==="string")for(const token of value.split(/\\s+/))if(/^[a-z0-9_-]+$/i.test(token))node.classList.add(token)}for(const node of host.querySelectorAll("[data-percent]")){let value=state;for(const key of node.getAttribute("data-percent").split("."))value=value==null?undefined:value[key];node.style.setProperty("--percent",Math.min(100,Math.max(0,Number(value)||0))+"%")}for(const node of host.querySelectorAll("[data-rotate]")){let value=state;for(const key of node.getAttribute("data-rotate").split("."))value=value==null?undefined:value[key];const degrees=Number(value);node.style.setProperty("--rotate",(Number.isFinite(degrees)?degrees:0)+"deg")}for(const [key,value] of Object.entries(state.config||{})){host.style.setProperty("--config-"+key.replaceAll("_","-"),String(value));if(value===true)host.classList.add("config-"+key.replaceAll("_","-"))}})()</script>`;
  return { html, mode };
}

export async function composeScreen(
  screen: Screen,
  widgets: readonly Widget[],
  options: { forceMock?: boolean; allowMock?: boolean; strict?: boolean; warnings?: string[] } = {},
): Promise<{ html: string; modes: string[] }> {
  const rendered = await Promise.all(widgets.map((widget) => widgetHtml(widget, options)));
  return {
    html: composeScreenHtml({
      width: screen.width,
      height: screen.height,
      title: screen.name,
      widgets: widgets.map((widget, index) => ({
        id: widget.id, x: widget.x, y: widget.y, width: widget.width, height: widget.height,
        zIndex: widget.zIndex, html: rendered[index]!.html,
      })),
    }),
    modes: rendered.map((item) => item.mode),
  };
}

export async function renderDraft(
  screen: Screen,
  widgets: readonly Widget[],
  options: { forceMock?: boolean; allowMock?: boolean; device?: boolean } = {},
): Promise<{ png: Buffer; modes: string[] }> {
  const render = async () => {
    const composed = await composeScreen(screen, widgets, options);
    const source = await htmlRenderer.renderPng({ html: composed.html, width: screen.width, height: screen.height });
    const png = options.device
      ? (await prepareFrame(source, screen.colorMode as "bw" | "bwry", screen.panelLayout)).previewPng
      : source;
    return { png, modes: composed.modes };
  };
  if (!options.forceMock) return render();
  const key = renderCacheKey({
    kind: "draft",
    screen: {
      width: screen.width,
      height: screen.height,
      colorMode: screen.colorMode,
      panelLayout: screen.panelLayout,
    },
    device: options.device ?? false,
    widgets: widgets.map((widget) => ({
      x: widget.x,
      y: widget.y,
      zIndex: widget.zIndex,
      revision: widgetRenderRevision(widget),
    })),
  });
  return draftPreviewCache.getOrCreate(key, render);
}

export async function renderWidgetPreview(
  screen: Screen,
  widget: Widget,
  sourceOverride?: WidgetSource,
  dataOverride?: unknown,
  testManifest?: WidgetStyleManifest,
): Promise<Buffer> {
  const key = renderCacheKey({
    kind: "widget",
    colorMode: screen.colorMode,
    revision: widgetRenderRevision(widget),
    sourceOverride,
    dataOverride,
    testManifest,
  });
  return widgetPreviewCache.getOrCreate(key, async () => {
    const rendered = await widgetHtml(widget, {
      forceMock: true,
      allowMock: true,
      ...(sourceOverride ? { sourceOverride } : {}),
      ...(dataOverride !== undefined ? { dataOverride } : {}),
    });
    const source = await htmlRenderer.renderPng({
      html: composeScreenHtml({ width: widget.width, height: widget.height, widgets: [{ x: 0, y: 0, width: widget.width, height: widget.height, html: rendered.html }] }),
      width: widget.width, height: widget.height,
    });
    const usesAccentColors = testManifest?.requiredColors
      .some((color) => color === "red" || color === "yellow");
    const colorMode = testManifest && !usesAccentColors ? "bw" : screen.colorMode as "bw" | "bwry";
    return (await prepareFrame(source, colorMode, "linear")).previewPng;
  });
}

export async function publishSnapshot(screenId: string, forceMock = false): Promise<string | null> {
  const screen = db.select().from(screens).where(eq(screens.id, screenId)).get();
  if (!screen || !screen.enabled) return null;
  const widgets = db.select().from(widgetInstances).where(eq(widgetInstances.screenId, screenId)).orderBy(asc(widgetInstances.zIndex)).all();
  const started = performance.now();
  const { html } = await composeScreen(screen, widgets, { forceMock, allowMock: forceMock });
  const source = await htmlRenderer.renderPng({ html, width: screen.width, height: screen.height });
  const frame = await prepareFrame(source, screen.colorMode as "bw" | "bwry", screen.panelLayout);
  const frameSha256 = sha256Hex(frame.frame);
  const previous = screen.currentSnapshotId
    ? db.select().from(snapshots).where(eq(snapshots.id, screen.currentSnapshotId)).get()
    : undefined;
  if (previous?.sha256 === frameSha256) {
    db.insert(renderMetrics).values({
      id: crypto.randomUUID(),
      screenId,
      durationMs: performance.now() - started,
      createdAt: new Date().toISOString(),
    }).run();
    return previous.id;
  }
  const snapshotId = crypto.randomUUID();
  let encodedRegions: EncodedDirtyRegion[] = [];
  if (previous && screen.colorMode === "bw") {
    try {
      const before = await quantizeBw(await readFile(previous.previewPath));
      encodedRegions = encodeDirtyBwRegions(
        before,
        frame.quantized as Awaited<ReturnType<typeof quantizeBw>>,
        {
          clips: widgets.map((widget) => ({
            x: widget.x,
            y: widget.y,
            width: widget.width,
            height: widget.height,
          })),
        },
      ) ?? [];
    } catch {
      encodedRegions = [];
    }
  }
  const regionArtifacts = encodedRegions.map((region) => ({
    id: crypto.randomUUID(),
    data: region.data,
    meta: region,
  }));
  const paths = await writeSnapshotAtomically({
    snapshotRoot: config.snapshotDir,
    screenId,
    snapshotId,
    artifacts: {
      frame: frame.frame, sourcePng: frame.sourcePng, previewPng: frame.previewPng,
      ...(regionArtifacts.length
        ? { regions: regionArtifacts.map(({ id, data }) => ({ id, data })) }
        : {}),
    },
  });
  const now = new Date().toISOString();
  sqlite.transaction(() => {
    db.insert(snapshots).values({
      id: snapshotId, screenId, baseSnapshotId: regionArtifacts.length ? previous?.id ?? null : null,
      encoding: frame.encoding, width: screen.width, height: screen.height,
      sha256: frameSha256, byteSize: frame.frame.length,
      framePath: paths.framePath, sourcePath: paths.sourcePath, previewPath: paths.previewPath, createdAt: now,
    }).run();
    for (const artifact of regionArtifacts) {
      const region = artifact.meta;
      db.insert(snapshotRegions).values({
        id: artifact.id, snapshotId, x: region.x, y: region.y, width: region.width, height: region.height,
        stride: region.stride, sha256: sha256Hex(region.data), byteSize: region.data.length,
        path: paths.regionPaths[artifact.id]!,
      }).run();
    }
    db.update(screens).set({ currentSnapshotId: snapshotId, updatedAt: now }).where(eq(screens.id, screenId)).run();
    db.insert(renderMetrics).values({ id: crypto.randomUUID(), screenId, durationMs: performance.now() - started, createdAt: now }).run();
  })();
  await cleanupSnapshots(screenId);
  return snapshotId;
}

export async function cleanupSnapshots(screenId: string): Promise<void> {
  const screen = db.select().from(screens).where(eq(screens.id, screenId)).get();
  if (!screen) return;
  const rows = db.select().from(snapshots).where(eq(snapshots.screenId, screenId)).all()
    .sort((left, right) => databaseTimestampMillis(right.createdAt) - databaseTimestampMillis(left.createdAt));
  const keep = new Set<string>();
  if (screen.currentSnapshotId) keep.add(screen.currentSnapshotId);
  for (const row of rows) {
    if (keep.size >= config.snapshotKeep) break;
    keep.add(row.id);
  }
  const removing = rows.filter((row) => !keep.has(row.id));
  await removeSnapshotDirectories(removing.map((row) => ({ id: row.id, createdAt: row.createdAt, directory: dirname(row.framePath) })));
  for (const row of removing) db.delete(snapshots).where(and(eq(snapshots.id, row.id), eq(snapshots.screenId, screenId))).run();
}
