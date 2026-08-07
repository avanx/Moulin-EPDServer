import { eq } from "drizzle-orm";

import { db } from "./db/index.js";
import { screens } from "./db/schema.js";
import { publishSnapshot } from "./rendering/service.js";

const timers = new Map<string, NodeJS.Timeout>();
const active = new Set<string>();
const pending = new Map<string, boolean>();

export async function renderScreen(screenId: string, forceMock = false): Promise<void> {
  if (active.has(screenId)) {
    pending.set(screenId, (pending.get(screenId) ?? false) || forceMock);
    return;
  }
  active.add(screenId);
  try {
    let nextForceMock = forceMock;
    do {
      await publishSnapshot(screenId, nextForceMock);
      if (!pending.has(screenId)) break;
      nextForceMock = pending.get(screenId) ?? false;
      pending.delete(screenId);
    } while (true);
  } finally {
    active.delete(screenId);
    pending.delete(screenId);
  }
}

export function unscheduleScreen(screenId: string): void {
  const timer = timers.get(screenId);
  if (timer) clearInterval(timer);
  timers.delete(screenId);
  pending.delete(screenId);
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
  pending.clear();
}

export function schedulerRunning(): boolean {
  return true;
}
