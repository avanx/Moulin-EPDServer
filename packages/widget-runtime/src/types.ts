export type LocalizedText = Record<string, string>;

export interface WidgetSize {
  width: number;
  height: number;
}

export interface WidgetStyleManifest {
  id: string;
  title: LocalizedText;
  defaultSize: WidgetSize;
  requiredColors: string[];
}

export interface ExternalDataContract {
  provider: string;
  cacheSeconds: number;
  staleSeconds?: number;
  secretConfigField?: string;
  allowedHosts?: string[];
  description?: LocalizedText;
}

export interface WidgetManifest {
  type: string;
  title: LocalizedText;
  description: LocalizedText;
  version: string;
  defaultStyle: string;
  supportsMock: boolean;
  mockConfig: Record<string, unknown>;
  mockData: Record<string, unknown>;
  externalData?: ExternalDataContract;
}

export interface RenderDocumentInput {
  template: string;
  style: string;
  data?: unknown;
  config?: unknown;
  size: WidgetSize;
  locale?: string;
  title?: string;
}

export interface WidgetRenderState<TData = unknown, TConfig = unknown> {
  data: TData;
  config: TConfig;
  size: WidgetSize;
  locale: string;
}

export interface WidgetRequestInit extends RequestInit {
  secretCookies?: Record<string, string>;
}

export interface BambuPrinterStatusOptions {
  host: string;
  serial: string;
  accessSecretId: string;
}

export interface BambuPrinterStatus {
  status: string;
  percentage: number;
  remainingMinutes: number;
  currentLayer: number;
  totalLayers: number;
  taskName: string;
}

export type KlipperCompatibility = "general" | "snapmaker_u1";

export interface KlipperPrinterStatusOptions {
  host: string;
  port?: number;
  compatibility: KlipperCompatibility;
  apiSecretId?: string;
}

export interface KlipperPrinterStatus {
  status: string;
  percentage: number;
  remainingMinutes: number;
  currentLayer: number;
  totalLayers: number;
  taskName: string;
}

export interface WidgetDataServices {
  request(input: string, init?: WidgetRequestInit): Promise<Response>;
  getSecret(idOrName: string): Promise<string>;
  bambuPrinterStatus(options: BambuPrinterStatusOptions): Promise<BambuPrinterStatus>;
  klipperPrinterStatus(options: KlipperPrinterStatusOptions): Promise<KlipperPrinterStatus>;
  cachedProvider<T>(
    key: string,
    options: { ttlSeconds: number; staleSeconds?: number },
    fetcher: () => Promise<T>,
  ): Promise<T>;
}

export interface WidgetDataContext {
  services: WidgetDataServices;
  locale?: string;
}

export type WidgetDataAdapter<TSource, TView, TConfig = Record<string, unknown>> = (
  source: TSource,
  config: TConfig,
) => TView;
