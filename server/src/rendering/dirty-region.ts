import { encodeBw } from "./encode.js";
import type {
  DirtyClipRect,
  DirtyRegion,
  EncodedDirtyRegion,
  QuantizedBwImage,
  QuantizedBwryImage,
} from "./types.js";

type QuantizedImage = QuantizedBwImage | QuantizedBwryImage;

function sameDimensions(before: QuantizedImage, after: QuantizedImage): boolean {
  return before.width === after.width && before.height === after.height;
}

function alignRegionX(
  x0: number,
  x1: number,
  width: number,
): readonly [number, number] {
  return [
    Math.floor(x0 / 8) * 8,
    Math.min(width, Math.ceil(x1 / 8) * 8),
  ];
}

function clipBounds(
  imageWidth: number,
  imageHeight: number,
  clip?: DirtyClipRect,
): DirtyRegion | null {
  if (!clip) {
    return [0, 0, imageWidth, imageHeight];
  }
  const x0 = Math.max(0, Math.floor(clip.x));
  const y0 = Math.max(0, Math.floor(clip.y));
  const x1 = Math.min(imageWidth, Math.ceil(clip.x + clip.width));
  const y1 = Math.min(imageHeight, Math.ceil(clip.y + clip.height));
  if (x1 <= x0 || y1 <= y0) {
    return null;
  }
  return [x0, y0, x1, y1];
}

function pointInRect(x: number, y: number, rect: DirtyRegion): boolean {
  const [x0, y0, x1, y1] = rect;
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}

/** Returns half-open bounds with x coordinates expanded to byte boundaries. */
export function findDirtyRegion(
  before: QuantizedImage,
  after: QuantizedImage,
  clip?: DirtyClipRect,
): DirtyRegion | null {
  if (!sameDimensions(before, after)) {
    return null;
  }

  const bounds = clipBounds(after.width, after.height, clip);
  if (!bounds) {
    return null;
  }
  const [bx0, by0, bx1, by1] = bounds;

  let x0 = after.width;
  let y0 = after.height;
  let x1 = 0;
  let y1 = 0;

  for (let y = by0; y < by1; y += 1) {
    for (let x = bx0; x < bx1; x += 1) {
      const index = y * after.width + x;
      if (before.data[index] !== after.data[index]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
    }
  }

  if (x1 === 0) {
    return null;
  }
  const [ax0, ax1] = alignRegionX(x0, x1, after.width);
  return [ax0, y0, ax1, y1];
}

/** Dirty AABB of pixels that lie outside every clip rectangle. */
export function findDirtyRegionOutsideClips(
  before: QuantizedImage,
  after: QuantizedImage,
  clips: readonly DirtyClipRect[],
): DirtyRegion | null {
  if (!sameDimensions(before, after)) {
    return null;
  }
  if (clips.length === 0) {
    return findDirtyRegion(before, after);
  }

  const bounds = clips
    .map((clip) => clipBounds(after.width, after.height, clip))
    .filter((rect): rect is DirtyRegion => rect !== null);

  let x0 = after.width;
  let y0 = after.height;
  let x1 = 0;
  let y1 = 0;

  for (let y = 0; y < after.height; y += 1) {
    for (let x = 0; x < after.width; x += 1) {
      if (bounds.some((rect) => pointInRect(x, y, rect))) {
        continue;
      }
      const index = y * after.width + x;
      if (before.data[index] !== after.data[index]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
    }
  }

  if (x1 === 0) {
    return null;
  }
  const [ax0, ax1] = alignRegionX(x0, x1, after.width);
  return [ax0, y0, ax1, y1];
}

/**
 * Splits dirty pixels into per-clip regions (typically one per widget),
 * plus a leftover region for pixels outside all clips.
 */
export function findDirtyRegions(
  before: QuantizedImage,
  after: QuantizedImage,
  clips: readonly DirtyClipRect[] = [],
): DirtyRegion[] {
  if (!sameDimensions(before, after)) {
    return [];
  }

  if (clips.length === 0) {
    const region = findDirtyRegion(before, after);
    return region ? [region] : [];
  }

  const regions: DirtyRegion[] = [];
  for (const clip of clips) {
    const region = findDirtyRegion(before, after, clip);
    if (region) {
      regions.push(region);
    }
  }

  const leftover = findDirtyRegionOutsideClips(before, after, clips);
  if (leftover) {
    regions.push(leftover);
  }
  return regions;
}

export function dirtyAreaRatio(
  region: DirtyRegion,
  width: number,
  height: number,
): number {
  const [x0, y0, x1, y1] = region;
  return ((x1 - x0) * (y1 - y0)) / (width * height);
}

export function dirtyRegionsAreaRatio(
  regions: readonly DirtyRegion[],
  width: number,
  height: number,
): number {
  if (width <= 0 || height <= 0) {
    return 0;
  }
  let area = 0;
  for (const region of regions) {
    const [x0, y0, x1, y1] = region;
    area += (x1 - x0) * (y1 - y0);
  }
  return area / (width * height);
}

export function cropBw(
  image: QuantizedBwImage,
  region: DirtyRegion,
): QuantizedBwImage {
  const [x0, y0, x1, y1] = region;
  if (
    x0 < 0 ||
    y0 < 0 ||
    x1 > image.width ||
    y1 > image.height ||
    x1 <= x0 ||
    y1 <= y0
  ) {
    throw new RangeError("Dirty region is outside the image");
  }

  const width = x1 - x0;
  const height = y1 - y0;
  const data = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y += 1) {
    image.data.copy(
      data,
      y * width,
      (y0 + y) * image.width + x0,
      (y0 + y) * image.width + x1,
    );
  }
  return { data, width, height, channels: 1 };
}

function encodeOneRegion(
  before: QuantizedBwImage,
  after: QuantizedBwImage,
  region: DirtyRegion,
): EncodedDirtyRegion {
  const oldCropped = cropBw(before, region);
  const newCropped = cropBw(after, region);
  const [x0, y0] = region;
  const oldPlane = encodeBw(oldCropped);
  const newPlane = encodeBw(newCropped);
  if (oldPlane.length !== newPlane.length) {
    throw new Error("Old and new region planes must have equal length");
  }
  return {
    region,
    x: x0,
    y: y0,
    width: newCropped.width,
    height: newCropped.height,
    stride: Math.ceil(newCropped.width / 8),
    data: Buffer.concat([oldPlane, newPlane]),
  };
}

export interface EncodeDirtyBwRegionsOptions {
  readonly clips?: readonly DirtyClipRect[];
  /** Maximum combined region area as a fraction of the screen. */
  readonly maxAreaRatio?: number;
  /** Safety cap; exceeding falls back to full refresh. */
  readonly maxRegions?: number;
}

/**
 * Produces one or more BW partial updates when dimensions match, pixels
 * changed, and the combined aligned region area is at most maxAreaRatio.
 *
 * When `clips` (widget rects) are provided, dirty pixels are split per clip
 * plus a leftover region outside all clips — so dispersed widgets do not
 * inflate a single bounding box across the screen.
 *
 * Each region payload is `[old plane][new plane]`, each `stride * height`
 * bytes of `epd-bw-msb-v1`.
 */
export function encodeDirtyBwRegions(
  before: QuantizedBwImage,
  after: QuantizedBwImage,
  options: EncodeDirtyBwRegionsOptions = {},
): EncodedDirtyRegion[] | null {
  const maxAreaRatio = options.maxAreaRatio ?? 0.35;
  const maxRegions = options.maxRegions ?? 16;
  if (maxAreaRatio < 0 || maxAreaRatio > 1) {
    throw new RangeError("maxAreaRatio must be between 0 and 1");
  }
  if (maxRegions < 1) {
    throw new RangeError("maxRegions must be at least 1");
  }

  const regions = findDirtyRegions(before, after, options.clips ?? []);
  if (regions.length === 0) {
    return null;
  }
  if (regions.length > maxRegions) {
    return null;
  }
  if (dirtyRegionsAreaRatio(regions, after.width, after.height) > maxAreaRatio) {
    return null;
  }

  return regions.map((region) => encodeOneRegion(before, after, region));
}

/**
 * Single-region helper kept for callers that do not pass widget clips.
 */
export function encodeDirtyBwRegion(
  before: QuantizedBwImage,
  after: QuantizedBwImage,
  maxAreaRatio = 0.35,
): EncodedDirtyRegion | null {
  const regions = encodeDirtyBwRegions(before, after, { maxAreaRatio });
  return regions?.[0] ?? null;
}
