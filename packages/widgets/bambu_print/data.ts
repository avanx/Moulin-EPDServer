import type { BambuPrinterStatus, WidgetDataContext } from "../../widget-runtime/src";

export interface BambuPrintData extends BambuPrinterStatus {
  _stale?: boolean;
}

export interface BambuPrintConfig {
  host: string;
  serial: string;
  access_secret_id: string;
  cache_minutes: number;
}

export async function fetchData(
  context: WidgetDataContext,
  config: BambuPrintConfig,
): Promise<BambuPrintData> {
  const key = `bambu:${config.host}:${config.serial}:${config.access_secret_id}`;
  return context.services.cachedProvider(key, {
    ttlSeconds: config.cache_minutes * 60,
    staleSeconds: 600,
  }, () => context.services.bambuPrinterStatus({
    host: config.host,
    serial: config.serial,
    accessSecretId: config.access_secret_id,
  }));
}

const statusLabels: Record<string, string> = {
  RUNNING: "打印中",
  PAUSE: "已暂停",
  PREPARE: "准备中",
  SLICING: "切片中",
  FINISH: "已完成",
  IDLE: "空闲",
  FAILED: "异常",
  OFFLINE: "离线",
  UNKNOWN: "未知",
};

function remainingTime(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

export function adaptData(source: BambuPrintData) {
  const status = String(source.status || "UNKNOWN").toUpperCase();
  const percentage = Math.min(100, Math.max(0, Math.round(Number(source.percentage) || 0)));
  const currentLayer = Math.max(0, Math.round(Number(source.currentLayer) || 0));
  const totalLayers = Math.max(0, Math.round(Number(source.totalLayers) || 0));
  return {
    statusLabel: statusLabels[status] ?? status,
    statusClass: status.toLowerCase(),
    percentage,
    remaining: remainingTime(source.remainingMinutes),
    layers: `${currentLayer}/${totalLayers}`,
    taskName: source.taskName || "暂无打印任务",
    staleMessage: source._stale ? "连接异常 · 显示缓存" : "",
  };
}
