import type { WidgetDataContext } from "../../widget-runtime/src";

export interface QWeatherHourly {
  fxTime?: string;
  temp?: number;
  icon?: string;
}

export interface QWeatherSource {
  temp?: number;
  humidity?: number;
  pressure?: number;
  windSpeed?: number;
  wind360?: number;
  icon?: string;
  obsTime?: string;
  uv?: number;
  aqi?: number;
  hourly?: QWeatherHourly[];
  _stale?: boolean;
}

export interface QWeatherConfig {
  api_host: string;
  project_id: string;
  kid: string;
  private_key_secret_id: string;
  latitude: number;
  longitude: number;
  temperature_unit: string;
  cache_minutes: number;
}

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

function locationQuery(config: QWeatherConfig): string {
  return `${coord(config.longitude)},${coord(config.latitude)}`;
}

function parseNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

const KNOWN_WEATHER_ICONS = new Set([
  100, 101, 102, 103, 104, 150, 151, 152, 153,
  300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 350, 351, 399,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 456, 457, 499,
  500, 501, 502, 503, 504, 507, 508, 509, 510, 511, 512, 513, 514, 515,
  900, 901, 999,
]);

/** Map QWeather icon / condition.code to CSS class `qi-{code}` (official icon set). */
function weatherIconClass(icon?: string): string {
  const raw = String(icon ?? "999").trim();
  if (!/^\d+$/.test(raw)) return "qi-999";
  const code = Number(raw);
  return KNOWN_WEATHER_ICONS.has(code) ? `qi-${code}` : "qi-999";
}

function pickAqi(indexes: Array<{ code?: string; aqi?: number }> | undefined): number | undefined {
  if (!indexes?.length) return undefined;
  const preferred = indexes.find((item) => item.code === "cn-mee")
    ?? indexes.find((item) => item.code === "us-epa")
    ?? indexes[0];
  return parseNumber(preferred?.aqi);
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
  config: QWeatherConfig,
): Promise<QWeatherSource> {
  const host = normalizeHost(config.api_host);
  if (!host) throw new Error("QWEATHER_API_HOST_REQUIRED");
  const privateKey = await context.services.getSecret(config.private_key_secret_id);
  const key = [
    "weather-qweather:v1",
    host,
    config.project_id,
    config.kid,
    coord(config.latitude),
    coord(config.longitude),
  ].join(":");

  return context.services.cachedProvider(key, {
    ttlSeconds: config.cache_minutes * 60,
    staleSeconds: 21600,
  }, async () => {
    const token = await createJwt(privateKey, config.kid, config.project_id);
    const location = encodeURIComponent(locationQuery(config));
    const lat = coord(config.latitude);
    const lon = coord(config.longitude);
    const base = `https://${host}`;

    const [now, hourly] = await Promise.all([
      requestJson<{
        code?: string;
        now?: {
          obsTime?: string;
          temp?: string;
          humidity?: string;
          pressure?: string;
          windSpeed?: string;
          wind360?: string;
          icon?: string;
        };
      }>(context, `${base}/v7/weather/now?location=${location}`, token),
      requestJson<{
        code?: string;
        hourly?: Array<{ fxTime?: string; temp?: string; icon?: string }>;
      }>(context, `${base}/v7/weather/24h?location=${location}`, token),
    ]);

    if (now.code !== "200" || !now.now) throw new Error(`QWEATHER_NOW_${now.code ?? "UNKNOWN"}`);
    if (hourly.code !== "200") throw new Error(`QWEATHER_HOURLY_${hourly.code ?? "UNKNOWN"}`);

    let uv: number | undefined;
    try {
      const daily = await requestJson<{
        code?: string;
        daily?: Array<{ uvIndex?: string }>;
      }>(context, `${base}/v7/weather/3d?location=${location}`, token);
      if (daily.code === "200") uv = parseNumber(daily.daily?.[0]?.uvIndex);
    } catch {
      // UV from daily forecast is optional.
    }

    let aqi: number | undefined;
    try {
      const air = await requestJson<{
        indexes?: Array<{ code?: string; aqi?: number }>;
      }>(context, `${base}/airquality/v1/current/${lat}/${lon}`, token);
      aqi = pickAqi(air.indexes);
    } catch {
      // Air quality may be unavailable for some locations or plans.
    }

    return {
      temp: parseNumber(now.now.temp),
      humidity: parseNumber(now.now.humidity),
      pressure: parseNumber(now.now.pressure),
      windSpeed: parseNumber(now.now.windSpeed),
      wind360: parseNumber(now.now.wind360),
      icon: now.now.icon,
      obsTime: now.now.obsTime,
      uv,
      aqi,
      hourly: (hourly.hourly ?? []).map((item) => ({
        fxTime: item.fxTime,
        temp: parseNumber(item.temp),
        icon: item.icon,
      })),
    };
  });
}

export function adaptData(source: QWeatherSource, config: { temperature_unit: string }) {
  const celsius = source.temp ?? 0;
  const temp = config.temperature_unit === "fahrenheit" ? celsius * 9 / 5 + 32 : celsius;
  const unit = config.temperature_unit === "fahrenheit" ? "°F" : "°C";
  const hours = source.hourly ?? [];
  const nextHour = source.obsTime
    ? hours.findIndex((item) => (item.fxTime ?? "") > source.obsTime!)
    : -1;
  const start = nextHour >= 0 ? nextHour : source.obsTime ? Math.max(0, hours.length - 4) : 0;
  const result: Record<string, unknown> = {
    temperature: `${Math.round(temp)}${unit}`,
    temperaturePrecise: `${temp.toFixed(1)}${unit}`,
    humidity: source.humidity ?? "--",
    pressure: source.pressure == null ? "--" : Math.round(source.pressure),
    windSpeed: source.windSpeed ?? "--",
    windDirection: source.wind360 ?? 0,
    uv: Math.round(source.uv ?? 0),
    aqi: source.aqi == null ? "--" : Math.round(source.aqi),
    weatherIcon: weatherIconClass(source.icon),
    stale: source._stale ? "STALE" : "",
  };
  for (let i = 0; i < 4; i++) {
    const item = hours[start + i];
    const stamp = item?.fxTime ?? "";
    const match = stamp.match(/T(\d{2}:\d{2})/);
    const forecastTemp = item?.temp;
    const displayTemp = forecastTemp == null
      ? ""
      : `${Math.round(config.temperature_unit === "fahrenheit" ? forecastTemp * 9 / 5 + 32 : forecastTemp)}°`;
    result[`forecast${i}Time`] = match?.[1] ?? "";
    result[`forecast${i}Temp`] = displayTemp;
    result[`forecast${i}Icon`] = weatherIconClass(item?.icon);
  }
  return result;
}
