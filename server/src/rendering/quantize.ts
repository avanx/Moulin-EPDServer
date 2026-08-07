import sharp from "sharp";

import type {
  QuantizedBwImage,
  QuantizedBwryImage,
  RawImage,
  SharpInput,
} from "./types.js";

export const BW_THRESHOLD = 160;
const BWRY_ACCENT_DISTANCE_LIMIT = 80 ** 2;

export const BWRY_PALETTE = [
  [255, 255, 255],
  [255, 220, 0],
  [220, 0, 0],
  [0, 0, 0],
] as const;

function assertRawImage(image: RawImage): void {
  if (!Number.isInteger(image.width) || image.width <= 0) {
    throw new RangeError("Image width must be a positive integer");
  }
  if (!Number.isInteger(image.height) || image.height <= 0) {
    throw new RangeError("Image height must be a positive integer");
  }
  const expected = image.width * image.height * image.channels;
  if (image.data.length !== expected) {
    throw new RangeError(`Raw image has ${image.data.length} bytes; expected ${expected}`);
  }
}

export async function readRawImage(input: SharpInput): Promise<RawImage> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3) {
    throw new Error(`Expected Sharp to produce 3 channels, got ${info.channels}`);
  }
  return {
    data,
    width: info.width,
    height: info.height,
    channels: 3,
  };
}

export function quantizeBwRaw(
  image: RawImage,
  threshold = BW_THRESHOLD,
): QuantizedBwImage {
  assertRawImage(image);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new RangeError("BW threshold must be between 0 and 255");
  }

  const output = Buffer.allocUnsafe(image.width * image.height);
  for (let pixel = 0; pixel < output.length; pixel += 1) {
    const offset = pixel * image.channels;
    const red = image.data[offset]!;
    const green = image.channels === 1 ? red : image.data[offset + 1]!;
    const blue = image.channels === 1 ? red : image.data[offset + 2]!;
    const luminance = Math.floor((299 * red + 587 * green + 114 * blue + 500) / 1000);
    output[pixel] = luminance >= threshold ? 255 : 0;
  }
  return { data: output, width: image.width, height: image.height, channels: 1 };
}

export async function quantizeBw(
  input: SharpInput,
  threshold = BW_THRESHOLD,
): Promise<QuantizedBwImage> {
  return quantizeBwRaw(await readRawImage(input), threshold);
}

export function quantizeBwryRaw(image: RawImage): QuantizedBwryImage {
  assertRawImage(image);
  const output = Buffer.allocUnsafe(image.width * image.height);

  for (let pixel = 0; pixel < output.length; pixel += 1) {
    const offset = pixel * image.channels;
    const red = image.data[offset]!;
    const green = image.channels === 1 ? red : image.data[offset + 1]!;
    const blue = image.channels === 1 ? red : image.data[offset + 2]!;
    const luminance = Math.floor((299 * red + 587 * green + 114 * blue + 500) / 1000);
    let bestIndex = 1;
    let bestDistance = Number.POSITIVE_INFINITY;

    // Only pixels sufficiently close to a physical accent color become red or
    // yellow. Colored subpixel-antialiasing fringes are otherwise quantized by
    // luminance, so black text stays achromatic.
    for (let index = 1; index <= 2; index += 1) {
      const color = BWRY_PALETTE[index]!;
      const distance =
        (red - color[0]) ** 2 +
        (green - color[1]) ** 2 +
        (blue - color[2]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    output[pixel] = bestDistance <= BWRY_ACCENT_DISTANCE_LIMIT
      ? bestIndex
      : luminance >= BW_THRESHOLD ? 0 : 3;
  }
  return { data: output, width: image.width, height: image.height, channels: 1 };
}

export async function quantizeBwry(input: SharpInput): Promise<QuantizedBwryImage> {
  return quantizeBwryRaw(await readRawImage(input));
}

export async function bwToPng(image: QuantizedBwImage): Promise<Buffer> {
  assertRawImage(image);
  const rgb = Buffer.allocUnsafe(image.data.length * 3);
  for (let pixel = 0; pixel < image.data.length; pixel += 1) {
    const value = image.data[pixel]!;
    const offset = pixel * 3;
    rgb[offset] = value;
    rgb[offset + 1] = value;
    rgb[offset + 2] = value;
  }
  return sharp(rgb, {
    raw: { width: image.width, height: image.height, channels: 3 },
  })
    .png()
    .toBuffer();
}

export async function bwryToPng(image: QuantizedBwryImage): Promise<Buffer> {
  assertRawImage(image);
  const rgb = Buffer.allocUnsafe(image.width * image.height * 3);
  for (let pixel = 0; pixel < image.data.length; pixel += 1) {
    const color = BWRY_PALETTE[image.data[pixel]!]!;
    const offset = pixel * 3;
    rgb[offset] = color[0];
    rgb[offset + 1] = color[1];
    rgb[offset + 2] = color[2];
  }
  return sharp(rgb, {
    raw: { width: image.width, height: image.height, channels: 3 },
  })
    .png()
    .toBuffer();
}
