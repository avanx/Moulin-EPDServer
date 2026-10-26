import type { ClaudeCodeUsage, WidgetDataContext } from "../../widget-runtime/src";

export interface ClaudeUsageData extends ClaudeCodeUsage {
  _stale?: boolean;
}

export interface ClaudeUsageConfig {
  secret_id: string;
  cache_minutes: number;
}

export async function fetchData(
  context: WidgetDataContext,
  config: ClaudeUsageConfig,
): Promise<ClaudeUsageData> {
  return context.services.cachedProvider(`claude:usage:${config.secret_id}`, {
    ttlSeconds: config.cache_minutes * 60,
    staleSeconds: 86400,
  }, () => context.services.claudeCodeUsage({ secretId: config.secret_id }));
}

function percent(value: unknown): string {
  const number = Number(value);
  return (Number.isFinite(number) ? number : 0).toFixed(1);
}

function shortReset(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function adaptData(data: ClaudeUsageData) {
  return {
    fiveHourPercent: percent(data.fiveHourPercent),
    sevenDayPercent: percent(data.sevenDayPercent),
    fiveHourReset: shortReset(data.fiveHourResetsAt),
    sevenDayReset: shortReset(data.sevenDayResetsAt),
    staleMessage: data._stale ? "Token/API error · cached data" : "",
  };
}
