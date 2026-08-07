import type {
  KlipperCompatibility,
  KlipperPrinterStatus,
  WidgetDataContext,
} from "../../widget-runtime/src";

export interface KlipperPrintData extends KlipperPrinterStatus {
  _stale?: boolean;
}

export interface KlipperPrintConfig {
  compatibility: KlipperCompatibility;
  host: string;
  port: number;
  api_secret_id?: string;
  cache_minutes: number;
}

export async function fetchData(
  context: WidgetDataContext,
  config: KlipperPrintConfig,
): Promise<KlipperPrintData> {
  const port = Number(config.port) || 0;
  const secretId = config.api_secret_id?.trim();
  const key = `klipper:${config.compatibility}:${config.host}:${port}:${secretId ?? ""}`;
  return context.services.cachedProvider(key, {
    ttlSeconds: config.cache_minutes * 60,
    staleSeconds: 600,
  }, () => context.services.klipperPrinterStatus({
    host: config.host,
    compatibility: config.compatibility,
    ...(port ? { port } : {}),
    ...(secretId ? { apiSecretId: secretId } : {}),
  }));
}

const statusLabels: Record<string, string> = {
  printing: "打印中",
  paused: "已暂停",
  standby: "空闲",
  complete: "已完成",
  cancelled: "已取消",
  error: "异常",
  offline: "离线",
  unknown: "未知",
};

function remainingTime(minutes: number): string {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

export function adaptData(source: KlipperPrintData) {
  const status = String(source.status || "unknown").toLowerCase();
  const percentage = Math.min(100, Math.max(0, Math.round(Number(source.percentage) || 0)));
  const currentLayer = Math.max(0, Math.round(Number(source.currentLayer) || 0));
  const totalLayers = Math.max(0, Math.round(Number(source.totalLayers) || 0));
  const layers = totalLayers > 0
    ? `${currentLayer}/${totalLayers}`
    : currentLayer > 0
      ? `${currentLayer}/--`
      : "--";
  return {
    statusLabel: statusLabels[status] ?? status,
    statusClass: status,
    percentage,
    remaining: remainingTime(source.remainingMinutes),
    layers,
    taskName: source.taskName || "暂无打印任务",
    staleMessage: source._stale ? "连接异常 · 显示缓存" : "",
  };
}
