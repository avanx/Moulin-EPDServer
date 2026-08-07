export interface ClockSource { now?: string | number | Date }
export interface ClockConfig { format: string; show_date: boolean; timezone: string }

export const fetchData = async (): Promise<ClockSource> => ({ now: new Date() });

const pad = (n: number) => String(n).padStart(2, "0");

function zonedParts(date: Date, timeZone: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const bag: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") bag[part.type] = part.value;
    }
    return {
      year: Number(bag.year),
      month: Number(bag.month),
      day: Number(bag.day),
      hour: Number(bag.hour),
      minute: Number(bag.minute),
      second: Number(bag.second),
    };
  } catch {
    // Invalid IANA timezone → fall back to the renderer's local zone.
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }
}

const dotGlyphs: Record<string, string[]> = {
  "0": ["11111", "10001", "10001", "10001", "10001", "10001", "11111"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
  "3": ["11111", "00001", "00001", "11111", "00001", "00001", "11111"],
  "4": ["10001", "10001", "10001", "11111", "00001", "00001", "00001"],
  "5": ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
  "6": ["11111", "10000", "10000", "11111", "10001", "10001", "11111"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["11111", "10001", "10001", "11111", "10001", "10001", "11111"],
  "9": ["11111", "10001", "10001", "11111", "00001", "00001", "11111"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
};

const dotMatrix = (value: string) => Array.from({ length: 7 }, (_, row) =>
  [...value].map((char) => dotGlyphs[char]?.[row] ?? "00000")
    .join("0").replaceAll("0", " ").replaceAll("1", "■"),
).join("\n");

export function adaptData(source: ClockSource, config: ClockConfig) {
  const date = new Date(source.now ?? Date.now());
  const parts = zonedParts(date, config.timezone || "Asia/Shanghai");
  const hour12 = parts.hour % 12 || 12;
  const tokens: Record<string, string> = {
    "%H": pad(parts.hour),
    "%I": pad(hour12),
    "%M": pad(parts.minute),
    "%S": pad(parts.second),
    "%p": parts.hour < 12 ? "AM" : "PM",
    "%Y": String(parts.year),
    "%m": pad(parts.month),
    "%d": pad(parts.day),
    "%%": "%",
  };
  const format = (pattern: string) => pattern.replace(/%%|%[HIMSpYmd]/g, (token) => tokens[token] ?? token);
  const calendar = format("%Y-%m-%d");
  const time = format(config.format);
  return {
    time,
    timeDots: dotMatrix(time),
    date: config.show_date ? calendar : "",
    dateDots: config.show_date ? dotMatrix(calendar) : "",
    calendar,
    calendarYearDots: dotMatrix(format("%Y")),
    calendarDateDots: dotMatrix(format("%m-%d")),
  };
}
