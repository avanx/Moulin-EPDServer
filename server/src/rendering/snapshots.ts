import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type {
  SnapshotCleanupPlan,
  SnapshotCleanupRecord,
  SnapshotPaths,
  SnapshotWriteOptions,
} from "./types.js";

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function safePathSegment(name: string, value: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    throw new Error(`${name} is not a safe path segment`);
  }
  return value;
}

export function snapshotPaths(
  snapshotRoot: string,
  screenId: string,
  snapshotId: string,
  regionIds: readonly string[] = [],
): SnapshotPaths {
  const safeScreenId = safePathSegment("screenId", screenId);
  const safeSnapshotId = safePathSegment("snapshotId", snapshotId);
  const directory = join(snapshotRoot, safeScreenId, safeSnapshotId);
  const regionPaths: Record<string, string> = {};
  for (const id of regionIds) {
    const safeId = safePathSegment("regionId", id);
    if (regionPaths[id] !== undefined) {
      throw new Error(`Duplicate region id: ${id}`);
    }
    regionPaths[id] = join(directory, `region-${safeId}.bin`);
  }
  return {
    directory,
    framePath: join(directory, "frame.bin"),
    sourcePath: join(directory, "source.png"),
    previewPath: join(directory, "preview.png"),
    regionPaths,
  };
}

/**
 * Writes a complete snapshot into a sibling temporary directory, then exposes
 * it with one rename. Callers can persist the returned final paths afterward.
 */
export async function writeSnapshotAtomically(
  options: SnapshotWriteOptions,
): Promise<SnapshotPaths> {
  const screenId = safePathSegment("screenId", options.screenId);
  const snapshotId = safePathSegment("snapshotId", options.snapshotId);
  const screenDirectory = join(options.snapshotRoot, screenId);
  await mkdir(screenDirectory, { recursive: true });
  const temporary = await mkdtemp(join(screenDirectory, ".render-"));
  const regionIds = (options.artifacts.regions ?? []).map((region) => region.id);
  const finalPaths = snapshotPaths(
    options.snapshotRoot,
    screenId,
    snapshotId,
    regionIds,
  );

  try {
    const writes: Promise<void>[] = [
      writeFile(join(temporary, "frame.bin"), options.artifacts.frame),
      writeFile(join(temporary, "source.png"), options.artifacts.sourcePng),
      writeFile(join(temporary, "preview.png"), options.artifacts.previewPng),
    ];
    const seenRegionIds = new Set<string>();
    for (const region of options.artifacts.regions ?? []) {
      const regionId = safePathSegment("regionId", region.id);
      if (seenRegionIds.has(regionId)) {
        throw new Error(`Duplicate region id: ${region.id}`);
      }
      seenRegionIds.add(regionId);
      writes.push(
        writeFile(join(temporary, `region-${regionId}.bin`), region.data),
      );
    }
    await Promise.all(writes);
    await renameWithRetry(temporary, finalPaths.directory);
    return finalPaths;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function createdAtMillis(record: SnapshotCleanupRecord): number {
  const value =
    record.createdAt instanceof Date
      ? record.createdAt.getTime()
      : typeof record.createdAt === "number"
        ? record.createdAt
        : Date.parse(record.createdAt);
  if (!Number.isFinite(value)) {
    throw new RangeError(`Snapshot ${record.id} has an invalid createdAt value`);
  }
  return value;
}

/** Pure retention planner: preserve current, then newest snapshots to capacity. */
export function planSnapshotCleanup(
  snapshots: readonly SnapshotCleanupRecord[],
  currentSnapshotId: string | null | undefined,
  keepCount: number,
): SnapshotCleanupPlan {
  if (!Number.isInteger(keepCount) || keepCount < 0) {
    throw new RangeError("keepCount must be a non-negative integer");
  }
  const sorted = snapshots
    .map((record, sourceIndex) => ({
      record,
      sourceIndex,
      createdAt: createdAtMillis(record),
    }))
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || left.sourceIndex - right.sourceIndex,
    )
    .map(({ record }) => record);

  const knownIds = new Set(sorted.map((record) => record.id));
  const keepIds = new Set<string>();
  if (currentSnapshotId !== null && currentSnapshotId !== undefined && knownIds.has(currentSnapshotId)) {
    keepIds.add(currentSnapshotId);
  }
  for (const record of sorted) {
    if (keepIds.size >= keepCount) {
      break;
    }
    keepIds.add(record.id);
  }
  return {
    keep: sorted.filter((record) => keepIds.has(record.id)),
    remove: sorted.filter((record) => !keepIds.has(record.id)),
  };
}

export async function removeSnapshotDirectories(
  records: readonly SnapshotCleanupRecord[],
): Promise<void> {
  await Promise.all(
    records.map((record) =>
      rm(record.directory, { recursive: true, force: true }),
    ),
  );
}
