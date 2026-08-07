import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";

import { config } from "../config.js";
import { compileDataSource } from "./data-runner.js";

const Ajv2020 = Ajv2020Module.default;

export interface WidgetManifest {
  type: string;
  title: Record<string, string>;
  description?: Record<string, string>;
  version: string;
  defaultStyle: string;
  supportsMock: boolean;
  mockConfig: Record<string, unknown>;
  mockData: Record<string, unknown>;
  externalData?: {
    provider: string;
    cacheSeconds: number;
    staleSeconds?: number;
    secretConfigField?: string;
    allowedHosts?: string[];
    description?: Record<string, string>;
  };
}

export interface WidgetStyle {
  id: string;
  title: Record<string, string>;
  defaultSize: { width: number; height: number };
  requiredColors: string[];
  template: string;
  css: string;
}

export type WidgetStyleManifest = Omit<WidgetStyle, "template" | "css">;

export interface LoadedWidget {
  directory: string;
  packageName: string;
  manifest: WidgetManifest;
  schema: Record<string, unknown>;
  settingsUi: Record<string, unknown>;
  styles: Map<string, WidgetStyle>;
  baseStyles: Map<string, WidgetStyle>;
  baseDataSource: string;
  dataSource: string;
  metadata(): Record<string, unknown>;
}

export interface PluginRecord {
  type: string;
  packageName: string;
  version: string;
  sourceType: "directory";
  sourceUrl: string;
  sourceRef: null;
  status: "available" | "load_error";
  loadError: string | null;
  metadata: Record<string, unknown>;
}

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

function validateLocalized(value: unknown, name: string): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.keys(value).length ||
      Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a non-empty string mapping`);
  }
}

function validateStyleMetadata(style: WidgetStyleManifest): void {
  if (!style.id || typeof style.id !== "string") throw new Error("Style id must not be empty");
  validateLocalized(style.title, `Style ${style.id} title`);
  if (!style.defaultSize || !Number.isInteger(style.defaultSize.width) ||
      !Number.isInteger(style.defaultSize.height) ||
      style.defaultSize.width <= 0 || style.defaultSize.height <= 0) {
    throw new Error(`Style ${style.id} defaultSize must contain positive integers`);
  }
  const knownColors = new Set(["black", "white", "red", "yellow"]);
  if (!Array.isArray(style.requiredColors) || !style.requiredColors.length ||
      style.requiredColors.some((color) => typeof color !== "string" ||
        color !== color.trim().toLowerCase() || !knownColors.has(color)) ||
      new Set(style.requiredColors).size !== style.requiredColors.length) {
    throw new Error(`Style ${style.id} requiredColors is invalid`);
  }
}

export interface WidgetSource {
  template: string;
  style: string;
}

interface WidgetSourceRevision extends WidgetSource {
  manifest?: WidgetStyleManifest;
}

export interface WidgetSourceDocument extends WidgetSource {
  type: string;
  styleId: string;
  builtin: boolean;
  manifest: WidgetStyleManifest;
  mockData: Record<string, unknown>;
  draft: boolean;
  published: boolean;
}

export interface WidgetDataSourceDocument {
  type: string;
  source: string;
  draft: boolean;
  published: boolean;
}

export interface RepositoryStyleResult {
  styleId: string;
  metadata: Record<string, unknown>;
}

const SOURCE_LIMITS = { template: 100_000, style: 100_000 } as const;
const DATA_SOURCE_LIMIT = 200_000;

function validateSource(value: unknown): WidgetSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Widget source must be an object");
  }
  const raw = value as Record<string, unknown>;
  const values = [raw.template, raw.style];
  if (values.some((item) => typeof item !== "string")) {
    throw new Error("template and style must be strings");
  }
  const source: WidgetSource = {
    template: values[0] as string,
    style: values[1] as string,
  };
  for (const [name, limit] of Object.entries(SOURCE_LIMITS)) {
    const text = source[name as keyof WidgetSource];
    if (Buffer.byteLength(text, "utf8") > limit) throw new Error(`${name} exceeds ${limit} bytes`);
  }
  if (/<\s*(script|iframe|object|embed|link|meta|base)\b/i.test(source.template) ||
      /\son[a-z]+\s*=/i.test(source.template)) {
    throw new Error("Template cannot contain executable or embedded content");
  }
  if (/@import\b/i.test(source.style) || /expression\s*\(/i.test(source.style) ||
      /url\s*\(\s*(['"]?)(?:https?:|\/\/)/i.test(source.style)) {
    throw new Error("CSS imports, expressions, and remote URLs are not allowed");
  }
  return source;
}

function validateStyleManifest(value: unknown, expectedId: string): WidgetStyleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Style manifest must be an object");
  }
  const raw = value as Record<string, unknown>;
  const manifest = {
    id: String(raw.id ?? ""),
    title: raw.title as Record<string, string>,
    defaultSize: raw.defaultSize as { width: number; height: number },
    requiredColors: raw.requiredColors as string[],
  };
  validateStyleMetadata(manifest);
  if (manifest.id !== expectedId) throw new Error("Style manifest id cannot be changed");
  return manifest;
}

function styleManifest(style: WidgetStyle): WidgetStyleManifest {
  return {
    id: style.id,
    title: { ...style.title },
    defaultSize: { ...style.defaultSize },
    requiredColors: [...style.requiredColors],
  };
}

function validateSourceRevision(
  value: unknown,
  styleId: string,
  fallbackManifest: WidgetStyleManifest,
): WidgetSourceRevision {
  const source = validateSource(value);
  const raw = value as Record<string, unknown>;
  return {
    ...source,
    manifest: raw.manifest === undefined
      ? fallbackManifest
      : validateStyleManifest(raw.manifest, styleId),
  };
}

function validateDataSource(value: unknown): string {
  const source = typeof value === "string"
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).source
      : undefined;
  if (typeof source !== "string") throw new Error("Data source must be a string");
  if (Buffer.byteLength(source, "utf8") > DATA_SOURCE_LIMIT) {
    throw new Error(`Data source exceeds ${DATA_SOURCE_LIMIT} bytes`);
  }
  return source;
}

async function loadWidget(directory: string): Promise<LoadedWidget> {
  const manifest = await readJson<WidgetManifest>(join(directory, "manifest.json"));
  const schema = await readJson<Record<string, unknown>>(join(directory, "schema.json"));
  const settingsUi = await readJson<Record<string, unknown>>(join(directory, "settings-ui.json"));
  if (!manifest.type || typeof manifest.type !== "string" ||
      !manifest.defaultStyle || typeof manifest.defaultStyle !== "string") {
    throw new Error("manifest.json is missing required widget metadata");
  }
  if (manifest.supportsMock !== true ||
      !manifest.mockConfig || typeof manifest.mockConfig !== "object" || Array.isArray(manifest.mockConfig) ||
      !manifest.mockData || typeof manifest.mockData !== "object" || Array.isArray(manifest.mockData)) {
    throw new Error("manifest.json must enable mock support and provide mockConfig and mockData objects");
  }
  validateLocalized(manifest.title, "Widget title");
  if (manifest.description !== undefined) validateLocalized(manifest.description, "Widget description");
  if (!schema || schema.type !== "object") throw new Error("schema.json must describe an object");
  const styles = new Map<string, WidgetStyle>();
  const stylesDirectory = join(directory, "styles");
  for (const entry of await readdir(stylesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const styleDirectory = join(stylesDirectory, entry.name);
    const styleManifest = await readJson<Omit<WidgetStyle, "template" | "css">>(
      join(styleDirectory, "style.manifest.json"),
    );
    validateStyleMetadata(styleManifest);
    if (styles.has(styleManifest.id)) throw new Error(`Duplicate style: ${styleManifest.id}`);
    styles.set(styleManifest.id, {
      ...styleManifest,
      template: await readFile(join(styleDirectory, "template.html"), "utf8"),
      css: await readFile(join(styleDirectory, "style.css"), "utf8"),
    });
  }
  if (!styles.has(manifest.defaultStyle)) {
    throw new Error(`Default style does not exist: ${manifest.defaultStyle}`);
  }
  const dataPath = join(directory, "data.ts");
  const dataSource = existsSync(dataPath) ? await readFile(dataPath, "utf8") : "";
  const widget: LoadedWidget = {
    directory,
    packageName: basename(directory),
    manifest,
    schema,
    settingsUi,
    styles,
    baseStyles: new Map([...styles].map(([id, style]) => [id, { ...style }])),
    baseDataSource: dataSource,
    dataSource,
    metadata: () => ({
      type: manifest.type,
      title: manifest.title,
      description: manifest.description ?? {},
      version: manifest.version,
      supportsMock: manifest.supportsMock,
      mockConfig: manifest.mockConfig,
      configSchema: schema,
      settingsUi,
      styles: [...styles.values()].map(({ id, title, defaultSize, requiredColors }) => ({
        id, title, defaultSize, requiredColors,
      })),
      defaultStyle: manifest.defaultStyle,
    }),
  };
  return widget;
}

export class WidgetRegistry {
  readonly #widgets = new Map<string, LoadedWidget>();
  readonly #records = new Map<string, PluginRecord>();
  readonly #ajv = new Ajv2020({ allErrors: true, useDefaults: true });
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #workspaceRoot = join(config.dataDir, "widget-workspace");

  #sourcePath(type: string, styleId: string, kind: "draft" | "published"): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(type) || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(styleId)) {
      throw new Error("Invalid widget type or style id");
    }
    return join(this.#workspaceRoot, type, styleId, `${kind}.json`);
  }

  #dataPath(type: string, kind: "draft" | "published"): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(type)) throw new Error("Invalid widget type");
    return join(this.#workspaceRoot, type, "data", `${kind}.ts`);
  }

  #customStylePath(type: string, styleId: string, file: "manifest.json" | "base.json"): string {
    this.#sourcePath(type, styleId, "draft");
    return join(this.#workspaceRoot, type, "styles", styleId, file);
  }

  async #readSource(path: string): Promise<WidgetSource | undefined> {
    if (!existsSync(path)) return undefined;
    return validateSource(JSON.parse(await readFile(path, "utf8")));
  }

  async #readRevision(path: string, styleId: string): Promise<WidgetSourceRevision | undefined> {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    const source = validateSource(raw);
    const value = raw as Record<string, unknown>;
    return {
      ...source,
      ...(value.manifest === undefined
        ? {}
        : { manifest: validateStyleManifest(value.manifest, styleId) }),
    };
  }

  async #writeSource(path: string, source: WidgetSource): Promise<void> {
    await this.#writeText(path, JSON.stringify(source));
  }

  async #writeRevision(path: string, revision: WidgetSourceRevision): Promise<void> {
    await this.#writeText(path, JSON.stringify(revision));
  }

  async #writeText(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  async #applyCustomStyles(widget: LoadedWidget): Promise<void> {
    const directory = join(this.#workspaceRoot, widget.manifest.type, "styles");
    if (!existsSync(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = await readJson<Omit<WidgetStyle, "template" | "css">>(
        this.#customStylePath(widget.manifest.type, entry.name, "manifest.json"),
      );
      validateStyleMetadata(manifest);
      if (manifest.id !== entry.name || widget.baseStyles.has(manifest.id)) {
        throw new Error(`Invalid or duplicate custom style: ${manifest.id}`);
      }
      const source = await this.#readSource(
        this.#customStylePath(widget.manifest.type, entry.name, "base.json"),
      );
      if (!source) throw new Error(`Custom style ${manifest.id} is missing base source`);
      const style: WidgetStyle = {
        ...manifest,
        template: source.template,
        css: source.style,
      };
      widget.baseStyles.set(style.id, { ...style });
      widget.styles.set(style.id, { ...style });
    }
  }

  async #applySavedStyles(widget: LoadedWidget): Promise<void> {
    for (const [styleId, base] of widget.baseStyles) {
      const draft = await this.#readRevision(
        this.#sourcePath(widget.manifest.type, styleId, "draft"),
        styleId,
      );
      const published = await this.#readRevision(
        this.#sourcePath(widget.manifest.type, styleId, "published"),
        styleId,
      );
      const revision = draft ?? published;
      widget.styles.set(styleId, revision
        ? { ...base, ...revision.manifest, template: revision.template, css: revision.style }
        : { ...base });
    }
  }

  async #applyPublishedData(widget: LoadedWidget): Promise<void> {
    const path = this.#dataPath(widget.manifest.type, "published");
    widget.dataSource = existsSync(path)
      ? validateDataSource(await readFile(path, "utf8"))
      : widget.baseDataSource;
  }

  async load(): Promise<void> {
    this.#widgets.clear();
    this.#records.clear();
    this.#validators.clear();
    const defaults = resolve(dirname(new URL(import.meta.url).pathname), "../../../packages/widgets");
    const roots = [resolve(process.cwd(), "../packages/widgets"), resolve(process.cwd(), "packages/widgets"), defaults, ...config.widgetDirs];
    const visited = new Set<string>();
    for (const candidate of roots) {
      const root = resolve(decodeURIComponent(candidate));
      if (visited.has(root) || !existsSync(root)) continue;
      visited.add(root);
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(root, entry.name);
        if (existsSync(join(directory, ".disabled")) || !existsSync(join(directory, "manifest.json"))) continue;
        let type = entry.name;
        try {
          const widget = await loadWidget(directory);
          await this.#applyCustomStyles(widget);
          await this.#applySavedStyles(widget);
          await this.#applyPublishedData(widget);
          type = widget.manifest.type;
          if (this.#widgets.has(type)) {
            this.#widgets.delete(type);
            throw new Error(`Duplicate widget type: ${type}`);
          }
          this.#widgets.set(widget.manifest.type, widget);
          this.#records.set(widget.manifest.type, {
            type: widget.manifest.type,
            packageName: widget.packageName,
            version: widget.manifest.version,
            sourceType: "directory",
            sourceUrl: directory,
            sourceRef: null,
            status: "available",
            loadError: null,
            metadata: widget.metadata(),
          });
        } catch (error) {
          this.#records.set(type, {
            type,
            packageName: entry.name,
            version: "unknown",
            sourceType: "directory",
            sourceUrl: directory,
            sourceRef: null,
            status: "load_error",
            loadError: String(error).slice(0, 1000),
            metadata: { type, title: { en: type, "zh-CN": type } },
          });
        }
      }
    }
  }

  get(type: string): LoadedWidget {
    const widget = this.#widgets.get(type);
    if (!widget) throw new Error(`Unknown widget type: ${type}`);
    return widget;
  }

  records(): PluginRecord[] { return [...this.#records.values()]; }
  metadata(): Record<string, unknown>[] { return [...this.#widgets.values()].map((item) => item.metadata()); }
  validateSource(raw: unknown): WidgetSource { return validateSource(raw); }
  validateStyleManifest(raw: unknown, styleId: string): WidgetStyleManifest {
    return validateStyleManifest(raw, styleId);
  }

  async cloneStyle(
    type: string,
    fromStyleId: string,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const widget = this.get(type);
    const from = widget.styles.get(fromStyleId);
    if (!from) throw new Error(`Unknown style '${fromStyleId}' for widget ${type}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid style details");
    const value = raw as Record<string, unknown>;
    const id = String(value.id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
      throw new Error("Style id must use 1-64 letters, numbers, underscores, or hyphens");
    }
    if (widget.baseStyles.has(id)) throw new Error(`Style already exists: ${id}`);
    const titleValue = value.title;
    const title = typeof titleValue === "string"
      ? { "zh-CN": titleValue.trim(), en: titleValue.trim() }
      : titleValue;
    validateLocalized(title, "Style title");
    const manifest = {
      id,
      title,
      defaultSize: { ...from.defaultSize },
      requiredColors: [...from.requiredColors],
    };
    const current = await this.source(type, fromStyleId);
    const base = { template: current.template, style: current.style };
    await this.#writeText(
      this.#customStylePath(type, id, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    await this.#writeSource(this.#customStylePath(type, id, "base.json"), base);
    const style: WidgetStyle = {
      ...manifest,
      template: base.template,
      css: base.style,
    };
    widget.baseStyles.set(id, { ...style });
    widget.styles.set(id, { ...style });
    const record = this.#records.get(type);
    if (record) record.metadata = widget.metadata();
    return widget.metadata();
  }

  async saveRepositoryStyle(
    type: string,
    fromStyleId: string,
    raw: unknown,
  ): Promise<RepositoryStyleResult> {
    const widget = this.get(type);
    const from = widget.styles.get(fromStyleId);
    const fromBase = widget.baseStyles.get(fromStyleId);
    if (!from || !fromBase) throw new Error(`Unknown style '${fromStyleId}' for widget ${type}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid style details");
    const value = raw as Record<string, unknown>;
    const id = String(value.id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
      throw new Error("Style id must use 1-64 letters, numbers, underscores, or hyphens");
    }
    if (widget.baseStyles.has(id)) throw new Error(`Style already exists: ${id}`);
    const titleValue = value.title;
    const title = typeof titleValue === "string"
      ? { "zh-CN": titleValue.trim(), en: titleValue.trim() }
      : titleValue;
    validateLocalized(title, "Style title");
    if (!value.source || typeof value.source !== "object" || Array.isArray(value.source)) {
      throw new Error("Style source must be an object");
    }
    const sourceValue = value.source as Record<string, unknown>;
    const source = validateSource(sourceValue);
    const sourceManifest = sourceValue.manifest === undefined
      ? styleManifest(from)
      : sourceValue.manifest;
    if (!sourceManifest || typeof sourceManifest !== "object" || Array.isArray(sourceManifest)) {
      throw new Error("Style manifest must be an object");
    }
    const manifest = validateStyleManifest({
      ...(sourceManifest as Record<string, unknown>),
      id,
      title,
    }, id);
    const style: WidgetStyle = {
      ...manifest,
      template: source.template,
      css: source.style,
    };
    const stylesDirectory = join(widget.directory, "styles");
    const destination = join(stylesDirectory, id);
    if (existsSync(destination)) throw new Error(`Style directory already exists: ${id}`);
    const temporary = join(widget.directory, `.style-${id}-${crypto.randomUUID()}.tmp`);
    let published = false;
    try {
      await mkdir(temporary);
      await Promise.all([
        this.#writeText(join(temporary, "template.html"), source.template),
        this.#writeText(join(temporary, "style.css"), source.style),
        this.#writeText(join(temporary, "style.manifest.json"), JSON.stringify(manifest, null, 2)),
      ]);
      await rename(temporary, destination);
      published = true;
      await Promise.all([
        rm(this.#sourcePath(type, fromStyleId, "draft"), { force: true }),
        rm(this.#sourcePath(type, fromStyleId, "published"), { force: true }),
      ]);
    } catch (error) {
      await rm(published ? destination : temporary, { recursive: true, force: true });
      throw error;
    }
    widget.styles.set(fromStyleId, { ...fromBase });
    widget.baseStyles.set(id, { ...style });
    widget.styles.set(id, { ...style });
    const record = this.#records.get(type);
    const metadata = widget.metadata();
    if (record) record.metadata = metadata;
    return { styleId: id, metadata };
  }

  async source(type: string, styleId: string): Promise<WidgetSourceDocument> {
    const widget = this.get(type);
    const base = widget.baseStyles.get(styleId);
    if (!base) throw new Error(`Unknown style '${styleId}' for widget ${type}`);
    const draft = await this.#readRevision(this.#sourcePath(type, styleId, "draft"), styleId);
    const published = await this.#readRevision(this.#sourcePath(type, styleId, "published"), styleId);
    const current = draft ?? published ?? { template: base.template, style: base.css };
    return {
      type,
      styleId,
      builtin: !existsSync(this.#customStylePath(type, styleId, "manifest.json")),
      template: current.template,
      style: current.style,
      manifest: current.manifest ?? published?.manifest ?? styleManifest(base),
      mockData: widget.manifest.mockData,
      draft: Boolean(draft),
      published: Boolean(published),
    };
  }

  async saveDraft(type: string, styleId: string, raw: unknown): Promise<WidgetSourceDocument> {
    const widget = this.get(type);
    const base = widget.baseStyles.get(styleId);
    const current = widget.styles.get(styleId);
    if (!base || !current) throw new Error(`Unknown style '${styleId}' for widget ${type}`);
    const revision = validateSourceRevision(raw, styleId, styleManifest(current));
    await this.#writeRevision(
      this.#sourcePath(type, styleId, "draft"),
      revision,
    );
    widget.styles.set(styleId, {
      ...base,
      ...revision.manifest,
      template: revision.template,
      css: revision.style,
    });
    const record = this.#records.get(type);
    if (record) record.metadata = widget.metadata();
    return this.source(type, styleId);
  }

  async discardDraft(type: string, styleId: string): Promise<WidgetSourceDocument> {
    const widget = this.get(type);
    const base = widget.baseStyles.get(styleId);
    if (!base) throw new Error(`Unknown style '${styleId}' for widget ${type}`);
    await rm(this.#sourcePath(type, styleId, "draft"), { force: true });
    const published = await this.#readRevision(this.#sourcePath(type, styleId, "published"), styleId);
    widget.styles.set(styleId, published
      ? { ...base, ...published.manifest, template: published.template, css: published.style }
      : { ...base });
    const record = this.#records.get(type);
    if (record) record.metadata = widget.metadata();
    return this.source(type, styleId);
  }

  async publish(type: string, styleId: string, raw?: unknown): Promise<WidgetSourceDocument> {
    const widget = this.get(type);
    const base = widget.baseStyles.get(styleId);
    if (!base) throw new Error(`Unknown style '${styleId}' for widget ${type}`);
    const current = widget.styles.get(styleId) ?? base;
    const revision = raw === undefined
      ? await this.#readRevision(this.#sourcePath(type, styleId, "draft"), styleId)
      : validateSourceRevision(raw, styleId, styleManifest(current));
    if (!revision) throw new Error("No draft source to publish");
    const published = {
      ...revision,
      manifest: revision.manifest ?? styleManifest(current),
    };
    await this.#writeRevision(this.#sourcePath(type, styleId, "published"), published);
    await rm(this.#sourcePath(type, styleId, "draft"), { force: true });
    widget.styles.set(styleId, {
      ...base,
      ...published.manifest,
      template: published.template,
      css: published.style,
    });
    const record = this.#records.get(type);
    if (record) record.metadata = widget.metadata();
    return this.source(type, styleId);
  }

  async restore(type: string, styleId: string): Promise<WidgetSourceDocument> {
    const widget = this.get(type);
    const base = widget.baseStyles.get(styleId);
    if (!base) throw new Error(`Unknown style '${styleId}' for widget ${type}`);
    if (existsSync(this.#customStylePath(type, styleId, "manifest.json"))) {
      throw new Error(`Cannot restore custom style '${styleId}'`);
    }
    await Promise.all([
      rm(this.#sourcePath(type, styleId, "draft"), { force: true }),
      rm(this.#sourcePath(type, styleId, "published"), { force: true }),
    ]);
    widget.styles.set(styleId, { ...base });
    const record = this.#records.get(type);
    if (record) record.metadata = widget.metadata();
    return this.source(type, styleId);
  }

  async dataSource(type: string): Promise<WidgetDataSourceDocument> {
    const widget = this.get(type);
    const draftPath = this.#dataPath(type, "draft");
    const publishedPath = this.#dataPath(type, "published");
    const draft = existsSync(draftPath) ? validateDataSource(await readFile(draftPath, "utf8")) : undefined;
    const published = existsSync(publishedPath)
      ? validateDataSource(await readFile(publishedPath, "utf8"))
      : undefined;
    return {
      type,
      source: draft ?? published ?? widget.baseDataSource,
      draft: draft !== undefined,
      published: published !== undefined,
    };
  }

  async saveDataDraft(type: string, raw: unknown): Promise<WidgetDataSourceDocument> {
    this.get(type);
    await this.#writeText(this.#dataPath(type, "draft"), validateDataSource(raw));
    return this.dataSource(type);
  }

  async discardDataDraft(type: string): Promise<WidgetDataSourceDocument> {
    this.get(type);
    await rm(this.#dataPath(type, "draft"), { force: true });
    return this.dataSource(type);
  }

  async publishData(type: string, raw?: unknown): Promise<WidgetDataSourceDocument> {
    const widget = this.get(type);
    const source = raw === undefined
      ? existsSync(this.#dataPath(type, "draft"))
        ? validateDataSource(await readFile(this.#dataPath(type, "draft"), "utf8"))
        : undefined
      : validateDataSource(raw);
    if (source === undefined) throw new Error("No data source draft to publish");
    await compileDataSource(source);
    await this.#writeText(this.#dataPath(type, "published"), source);
    await rm(this.#dataPath(type, "draft"), { force: true });
    widget.dataSource = source;
    return this.dataSource(type);
  }

  async restoreData(type: string): Promise<WidgetDataSourceDocument> {
    const widget = this.get(type);
    await Promise.all([
      rm(this.#dataPath(type, "draft"), { force: true }),
      rm(this.#dataPath(type, "published"), { force: true }),
    ]);
    widget.dataSource = widget.baseDataSource;
    return this.dataSource(type);
  }

  validate(type: string, raw: Record<string, unknown>, colorMode?: string): Record<string, unknown> {
    const widget = this.get(type);
    const cached = this.#validators.get(type);
    const validator: ValidateFunction = cached ?? this.#ajv.compile(widget.schema);
    if (!cached) this.#validators.set(type, validator);
    if (!validator(raw)) {
      const errors = (validator.errors ?? []).map((item) => `${item.instancePath}: ${item.message ?? "invalid"}`);
      throw new Error(errors.join("; ") || "Invalid widget configuration");
    }
    const styleId = String(raw.style_id ?? widget.manifest.defaultStyle);
    const style = widget.styles.get(styleId);
    if (!style) throw new Error(`Unknown style '${styleId}' for widget ${type}`);
    if (colorMode) {
      const available = colorMode === "bwry"
        ? new Set(["black", "white", "red", "yellow"])
        : new Set(["black", "white"]);
      const missing = style.requiredColors.filter((color) => !available.has(color));
      if (missing.length) throw new Error(`Style '${styleId}' for widget ${type} requires colors unavailable on ${colorMode}: ${missing.join(", ")}`);
    }
    return raw;
  }
}

export const registry = new WidgetRegistry();
