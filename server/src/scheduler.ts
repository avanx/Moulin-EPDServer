import { eq } from "drizzle-orm";

import { db } from "./db/index.js";
import { screens } from "./db/schema.js";
import { publishSnapshot } from "./rendering/service.js";
import { isSilentAt, msUntilNextRender } from "./silent-time.js";

const timers = new Map<string, NodeJS.Timeout>();
const generations = new Map<string, number>();
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
  if (timer) clearTimeout(timer);
  timers.delete(screenId);
  generations.set(screenId, (generations.get(screenId) ?? 0) + 1);
}

export function scheduleScreen(screen: typeof screens.$inferSelect): void {
  unscheduleScreen(screen.id);
  if (!screen.enabled) return;
  const generation = generations.get(screen.id) ?? 0;
  const arm = (delay: number) => {
    const timer = setTimeout(() => void tick(), delay);
    timer.unref();
    timers.set(screen.id, timer);
  };
  const tick = async () => {
    if (generations.get(screen.id) !== generation) return;
    const latest = db.select().from(screens).where(eq(screens.id, screen.id)).get();
    if (!latest?.enabled) return;
    if (!isSilentAt(latest)) await renderScreen(latest.id);
    if (generations.get(screen.id) !== generation) return;
    const current = db.select().from(screens).where(eq(screens.id, screen.id)).get();
    if (!current?.enabled) return;
    arm(msUntilNextRender(current));
  };
  arm(msUntilNextRender(screen));
}

export function loadSchedules(): void {
  for (const screen of db.select().from(screens).where(eq(screens.enabled, true)).all()) scheduleScreen(screen);
}

export function stopScheduler(): void {
  for (const id of [...timers.keys()]) unscheduleScreen(id);
}

export function schedulerRunning(): boolean {
  return true;
}
