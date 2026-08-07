import type { WidgetDataContext } from "../../widget-runtime/src";

export interface WeatherSource {
  temperature_2m?: number;
  relative_humidity_2m?: number;
  surface_pressure?: number;
  wind_speed_10m?: number;
  wind_direction_10m?: number;
  weather_code?: number;
  is_day?: number;
  uv_index?: number;
  european_aqi?: number;
  time?: string;
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    weather_code?: number[];
    is_day?: number[];
  };
  _stale?: boolean;
}

export interface WeatherConfig {
  latitude: number;
  longitude: number;
  temperature_unit: string;
  cache_minutes: number;
}

export async function fetchData(
  context: WidgetDataContext,
  config: WeatherConfig,
): Promise<WeatherSource> {
  const key = `weather:v2:${config.latitude.toFixed(4)}:${config.longitude.toFixed(4)}:${config.temperature_unit}`;
  return context.services.cachedProvider(key, {
    ttlSeconds: config.cache_minutes * 60,
    staleSeconds: 21600,
  }, async () => {
    const base = {
      latitude: String(config.latitude),
      longitude: String(config.longitude),
      timezone: "auto",
    };
    const weatherQuery = new URLSearchParams({
      ...base,
      current: "temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,weather_code,is_day,uv_index",
      hourly: "temperature_2m,precipitation_probability,weather_code,cloud_cover,is_day",
      temperature_unit: config.temperature_unit,
      forecast_days: "2",
    });
    const airQuery = new URLSearchParams({ ...base, current: "european_aqi" });
    const weatherResponse = await context.services.request(
      `https://api.open-meteo.com/v1/forecast?${weatherQuery}`,
    );
    if (!weatherResponse.ok) throw new Error(`OPEN_METEO_HTTP_${weatherResponse.status}`);
    const weather = await weatherResponse.json() as {
      current?: WeatherSource;
      hourly?: WeatherSource["hourly"];
    };
    if (!weather.current) throw new Error("OPEN_METEO_SCHEMA_CHANGED");

    let european_aqi: number | undefined;
    try {
      const airResponse = await context.services.request(
        `https://air-quality-api.open-meteo.com/v1/air-quality?${airQuery}`,
      );
      if (airResponse.ok) {
        const air = await airResponse.json() as { current?: { european_aqi?: number } };
        european_aqi = air.current?.european_aqi;
      }
    } catch {
      // Air quality host is often unreachable in some networks; keep forecast.
    }
    return { ...weather.current, hourly: weather.hourly, european_aqi };
  });
}

const iconClass = (code = 0, isDay = 1) =>
  code === 0 ? (isDay ? "sun" : "moon")
    : [1, 2].includes(code) ? "partly"
      : [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code) ? "rain"
        : [71, 73, 75, 77, 85, 86].includes(code) ? "snow"
          : [95, 96, 99].includes(code) ? "storm"
            : [45, 48].includes(code) ? "fog"
              : "cloud";

export function adaptData(source: WeatherSource, config: { temperature_unit: string }) {
  const unit = config.temperature_unit === "fahrenheit" ? "°F" : "°C";
  const times = source.hourly?.time ?? [];
  const temps = source.hourly?.temperature_2m ?? [];
  const codes = source.hourly?.weather_code ?? [];
  const dayStates = source.hourly?.is_day ?? [];
  const nextHour = source.time ? times.findIndex((time) => time > source.time!) : -1;
  const start = nextHour >= 0 ? nextHour : source.time ? Math.max(0, times.length - 4) : 0;
  const result: Record<string, unknown> = {
    temperature: `${Math.round(source.temperature_2m ?? 0)}${unit}`,
    temperaturePrecise: `${(source.temperature_2m ?? 0).toFixed(1)}${unit}`,
    humidity: source.relative_humidity_2m ?? "--",
    pressure: source.surface_pressure == null ? "--" : Math.round(source.surface_pressure),
    windSpeed: source.wind_speed_10m ?? "--",
    windDirection: source.wind_direction_10m ?? 0,
    uv: Math.round(source.uv_index ?? 0),
    aqi: source.european_aqi == null ? "--" : Math.round(source.european_aqi),
    weatherClass: iconClass(source.weather_code, source.is_day),
    stale: source._stale ? "STALE" : "",
  };
  for (let i = 0; i < 4; i++) {
    const n = start + i;
    const stamp = times[n] ?? "";
    result[`forecast${i}Time`] = stamp.split("T")[1]?.slice(0, 5) ?? "";
    result[`forecast${i}Temp`] = temps[n] == null ? "" : `${Math.round(temps[n]!)}°`;
    result[`forecast${i}Class`] = iconClass(codes[n], dayStates[n]);
  }
  return result;
}
