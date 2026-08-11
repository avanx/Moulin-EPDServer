import { eq } from "drizzle-orm";

import { db } from "./db/index.js";
import { screens } from "./db/schema.js";
import { publishSnapshot } from "./rendering/service.js";

const timers = new Map<string, NodeJS.Timeout>();
/** Serializes publishes per screen so each caller waits for a snapshot built from the latest DB state. */
const chains = new Map<string, Promise<string | null>>();

export async function renderScreen(screenId: string, forceMock = false): Promise<string | null> {
  const previous = chains.get(screenId);
  const next = previous
    ? previous.then(
      () => publishSnapshot(screenId, forceMock),
      () => publishSnapshot(screenId, forceMock),
    )
    : publishSnapshot(screenId, forceMock);
  chains.set(screenId, next);
  try {
    return await next;
  } finally {
    if (chains.get(screenId) === next) chains.delete(screenId);
  }
}

export function unscheduleScreen(screenId: string): void {
  const timer = timers.get(screenId);
  if (timer) clearInterval(timer);
  timers.delete(screenId);
}

export function scheduleScreen(screen: typeof screens.$inferSelect): void {
  unscheduleScreen(screen.id);
  if (!screen.enabled) return;
  const timer = setInterval(() => void renderScreen(screen.id), screen.refreshSeconds * 1000);
  timer.unref();
  timers.set(screen.id, timer);
}

export function loadSchedules(): void {
  for (const screen of db.select().from(screens).where(eq(screens.enabled, true)).all()) scheduleScreen(screen);
}

export function stopScheduler(): void {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
}

export function schedulerRunning(): boolean {
  return true;
}
