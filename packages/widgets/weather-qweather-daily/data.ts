import type { WidgetDataContext } from "../../widget-runtime/src";

export interface QWeatherDay {
  fxDate?: string;
  tempMax?: number;
  tempMin?: number;
  iconDay?: string;
  textDay?: string;
  humidity?: number;
  precip?: number;
  windDirDay?: string;
  windScaleDay?: string;
}

export interface QWeatherDailySource {
  updateTime?: string;
  daily?: QWeatherDay[];
  _stale?: boolean;
}

export interface QWeatherDailyConfig {
  api_host: string;
  project_id: string;
  kid: string;
  private_key_secret_id: string;
  latitude: number;
  longitude: number;
  temperature_unit: string;
  language: string;
  cache_minutes: number;
}

const DAY_COUNT = 4;

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlFromJson(value: unknown): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function decodePemPrivateKey(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("QWEATHER_PRIVATE_KEY_EMPTY");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function createJwt(privateKeyPem: string, kid: string, projectId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    decodePemPrivateKey(privateKeyPem),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const iat = Math.floor(Date.now() / 1000) - 30;
  const exp = iat + 900;
  const data = `${base64UrlFromJson({ alg: "EdDSA", kid })}.${base64UrlFromJson({ sub: projectId, iat, exp })}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(data)),
  );
  return `${data}.${base64UrlFromBytes(signature)}`;
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
}

function coord(value: number): string {
  return value.toFixed(2);
}

function apiLang(language: string): string {
  return language === "en" ? "en" : "zh";
}

function parseNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Daytime icons embedded in the styles; night variants (15x/35x/45x) are never used for iconDay. */
const KNOWN_WEATHER_ICONS = new Set([
  100, 101, 102, 103, 104,
  300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 399,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 499,
  500, 501, 502, 503, 504, 507, 508, 509, 510, 511, 512, 513, 514, 515,
  900, 901, 999,
]);

const NIGHT_TO_DAY: Record<number, number> = {
  150: 100, 151: 101, 152: 102, 153: 103,
  350: 300, 351: 301, 456: 406, 457: 407,
};

function weatherIconClass(icon?: string): string {
  const raw = String(icon ?? "999").trim();
  if (!/^\d+$/.test(raw)) return "qi-999";
  const parsed = Number(raw);
  const code = NIGHT_TO_DAY[parsed] ?? parsed;
  return KNOWN_WEATHER_ICONS.has(code) ? `qi-${code}` : "qi-999";
}

async function requestJson<T>(
  context: WidgetDataContext,
  url: string,
  token: string,
): Promise<T> {
  const response = await context.services.request(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Encoding": "gzip",
    },
  });
  if (response.status === 401 || response.status === 403) throw new Error("QWEATHER_AUTH_FAILED");
  if (!response.ok) throw new Error(`QWEATHER_HTTP_${response.status}`);
  return await response.json() as T;
}

export async function fetchData(
  context: WidgetDataContext,
  config: QWeatherDailyConfig,
): Promise<QWeatherDailySource> {
  const host = normalizeHost(config.api_host);
  if (!host) throw new Error("QWEATHER_API_HOST_REQUIRED");
  const privateKey = await context.services.getSecret(config.private_key_secret_id);
  const lang = apiLang(config.language);
  const key = [
    "weather-qweather-daily:v1",
    host,
    config.project_id,
    config.kid,
    coord(config.latitude),
    coord(config.longitude),
    lang,
  ].join(":");

  return context.services.cachedProvider(key, {
    ttlSeconds: config.cache_minutes * 60,
    staleSeconds: 43200,
  }, async () => {
    const token = await createJwt(privateKey, config.kid, config.project_id);
    const location = encodeURIComponent(`${coord(config.longitude)},${coord(config.latitude)}`);
    // The 3d endpoint only covers today + 2 days, so request 7d and keep today + 3.
    const result = await requestJson<{
      code?: string;
      updateTime?: string;
      daily?: Array<Record<string, string | undefined>>;
    }>(context, `https://${host}/v7/weather/7d?location=${location}&lang=${lang}`, token);
    if (result.code !== "200" || !result.daily?.length) {
      throw new Error(`QWEATHER_DAILY_${result.code ?? "UNKNOWN"}`);
    }
    return {
      updateTime: result.updateTime,
      daily: result.daily.map((item) => ({
        fxDate: item.fxDate,
        tempMax: parseNumber(item.tempMax),
        tempMin: parseNumber(item.tempMin),
        iconDay: item.iconDay,
        textDay: item.textDay,
        humidity: parseNumber(item.humidity),
        precip: parseNumber(item.precip),
        windDirDay: item.windDirDay,
        windScaleDay: item.windScaleDay,
      })),
    };
  });
}

/** Offset in minutes parsed from a QWeather timestamp such as `2026-07-28T10:35+08:00`. */
function offsetMinutes(stamp?: string): number | undefined {
  const match = stamp?.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!match) return undefined;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** Today's date (YYYY-MM-DD) at the forecast location, inferred from the response's UTC offset. */
function locationToday(updateTime?: string): string | undefined {
  const offset = offsetMinutes(updateTime);
  if (offset == null) return undefined;
  return new Date(Date.now() + offset * 60_000).toISOString().slice(0, 10);
}

const WEEKDAYS = {
  zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

function dayLabel(fxDate: string, language: string): string {
  const match = fxDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return (language === "en" ? WEEKDAYS.en : WEEKDAYS.zh)[weekday]!;
}

export function adaptData(
  source: QWeatherDailySource,
  config: { temperature_unit: string; language?: string },
) {
  const fahrenheit = config.temperature_unit === "fahrenheit";
  const language = config.language === "en" ? "en" : "zh";
  const formatTemp = (value?: number) => value == null
    ? "--"
    : `${Math.round(fahrenheit ? value * 9 / 5 + 32 : value)}°`;
  const days = source.daily ?? [];
  // Cached (possibly stale) data may have been fetched yesterday; skip days that are already past.
  const today = locationToday(source.updateTime);
  const todayIndex = today ? days.findIndex((item) => item.fxDate === today) : -1;
  const start = todayIndex >= 0 ? todayIndex : 0;
  const updated = source.updateTime?.match(/T(\d{2}:\d{2})/)?.[1] ?? "";

  const result: Record<string, unknown> = {
    unit: fahrenheit ? "°F" : "°C",
    updated: updated ? (language === "en" ? `Updated ${updated}` : `${updated} 更新`) : "",
    stale: source._stale ? "STALE" : "",
  };
  for (let i = 0; i < DAY_COUNT; i++) {
    const item = days[start + i];
    const fxDate = item?.fxDate ?? "";
    const date = fxDate.match(/^\d{4}-(\d{2})-(\d{2})$/);
    result[`day${i}Label`] = item ? dayLabel(fxDate, language) : "";
    result[`day${i}Date`] = date ? `${date[1]}/${date[2]}` : "";
    result[`day${i}Icon`] = item ? weatherIconClass(item.iconDay) : "";
    result[`day${i}Text`] = item?.textDay ?? "";
    result[`day${i}High`] = item ? formatTemp(item.tempMax) : "";
    result[`day${i}Low`] = item ? formatTemp(item.tempMin) : "";
    result[`day${i}Range`] = item ? `${formatTemp(item.tempMin)} / ${formatTemp(item.tempMax)}` : "";
    result[`day${i}Humidity`] = item?.humidity == null ? "" : `${Math.round(item.humidity)}%`;
  }
  return result;
}
