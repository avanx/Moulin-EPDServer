const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_SECONDS = 86_400;

export type SilentSchedule = {
  timezone: string;
  silentEnabled: boolean;
  silentStart: string;
  silentEnd: string;
};

export function isValidTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return value.length > 0 && value.length <= 64;
  } catch {
    return false;
  }
}

export function isValidClock(value: unknown): value is string {
  return typeof value === "string" && CLOCK.test(value);
}

export function parseClockMinutes(value: string): number | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function zonedParts(date: Date, timeZone: string): { hour: number; minute: number; second: number } {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const bag: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") bag[part.type] = part.value;
    }
    return { hour: Number(bag.hour), minute: Number(bag.minute), second: Number(bag.second) };
  } catch {
    return { hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() };
  }
}

function zonedDaySeconds(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 3600 + parts.minute * 60 + parts.second;
}

function windowSeconds(schedule: SilentSchedule): { start: number; end: number } | null {
  if (!schedule.silentEnabled) return null;
  const start = parseClockMinutes(schedule.silentStart);
  const end = parseClockMinutes(schedule.silentEnd);
  if (start === null || end === null || start === end) return null;
  return { start: start * 60, end: end * 60 };
}

export function isSilentAt(schedule: SilentSchedule, date = new Date()): boolean {
  const window = windowSeconds(schedule);
  if (!window) return false;
  const now = zonedDaySeconds(date, schedule.timezone);
  if (window.start < window.end) return now >= window.start && now < window.end;
  return now >= window.start || now < window.end;
}

export function secondsUntilSilentEnd(schedule: SilentSchedule, date = new Date()): number {
  const window = windowSeconds(schedule);
  if (!window) return 0;
  const now = zonedDaySeconds(date, schedule.timezone);
  if (window.start < window.end) return Math.max(1, window.end - now);
  if (now >= window.start) return Math.max(1, DAY_SECONDS - now + window.end);
  return Math.max(1, window.end - now);
}

export function msUntilNextRender(
  schedule: SilentSchedule & { refreshSeconds: number },
  date = new Date(),
): number {
  if (isSilentAt(schedule, date)) return secondsUntilSilentEnd(schedule, date) * 1000;
  const intervalMs = Math.max(2, schedule.refreshSeconds) * 1000;
  if (isSilentAt(schedule, new Date(date.getTime() + intervalMs))) {
    return secondsUntilSilentEnd(schedule, date) * 1000;
  }
  return intervalMs;
}
