import type { PanelLayout, QuantizedBwImage, QuantizedBwryImage } from "./types.js";

function assertDimensions(
  data: Uint8Array,
  width: number,
  height: number,
): void {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("Image dimensions must be positive integers");
  }
  if (data.length !== width * height) {
    throw new RangeError(`Image has ${data.length} pixels; expected ${width * height}`);
  }
}

/**
 * `epd-bw-msb-v1`: MSB-first rows, 1=black, 0=white, row stride
 * ceil(width / 8), row padding 0 (white). Same polarity for every panel
 * layout; controllers whose RAM uses 0=black invert on the device.
 */
export function encodeBw(image: QuantizedBwImage): Buffer {
  assertDimensions(image.data, image.width, image.height);
  const stride = Math.ceil(image.width / 8);
  const output = Buffer.alloc(stride * image.height);

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[y * image.width + x] === 0) {
        output[y * stride + Math.floor(x / 8)]! |= 0x80 >> (x % 8);
      }
    }
  }
  return output;
}

/**
 * `epd-bwr-plane-v1`: `[BW plane][R plane]`, each 1bpp MSB-first with row
 * stride ceil(width / 8).
 *
 * - BW plane: 0=black, 1=white (red pixels are white here)
 * - R plane: 1=red, 0=not red
 *
 * Input uses BWRY palette indexes; yellow (1) is rejected.
 */
export function encodeBwrPlanes(image: QuantizedBwryImage): Buffer {
  assertDimensions(image.data, image.width, image.height);
  const stride = Math.ceil(image.width / 8);
  const plane = stride * image.height;
  const output = Buffer.alloc(plane * 2);
  output.fill(0xff, 0, plane);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = y * image.width + x;
      const value = image.data[pixel]!;
      const offset = y * stride + Math.floor(x / 8);
      const mask = 0x80 >> (x % 8);
      if (value === 3) output[offset]! &= ~mask;
      else if (value === 2) output[plane + offset]! |= mask;
      else if (value !== 0) throw new RangeError(`Invalid BWR palette index ${value} at pixel ${pixel}`);
    }
  }
  return output;
}

/** Packs four palette indexes per byte, highest two bits first. */
export function pack2Bpp(pixels: Uint8Array): Buffer {
  const output = Buffer.alloc(Math.ceil(pixels.length / 4));
  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index]!;
    if (value > 3) {
      throw new RangeError(`Invalid BWRY palette index ${value} at pixel ${index}`);
    }
    output[Math.floor(index / 4)]! |=
      (value & 0x03) << (6 - 2 * (index % 4));
  }
  return output;
}

/** Image2LCD palette: 00 white, 01 yellow, 10 red, 11 black. */
export function encodeBwry(
  image: QuantizedBwryImage,
  panelLayout: PanelLayout,
): Buffer {
  assertDimensions(image.data, image.width, image.height);
  if (panelLayout !== "dual-panel-left-right") {
    return pack2Bpp(image.data);
  }
  if (image.width % 2 !== 0) {
    throw new RangeError("Dual-panel layout requires an even image width");
  }

  const panelWidth = image.width / 2;
  const panelPixels = panelWidth * image.height;
  const panels: Buffer[] = [];
  for (const panelStart of [0, panelWidth]) {
    const panel = Buffer.allocUnsafe(panelPixels);
    for (let y = 0; y < image.height; y += 1) {
      const sourceStart = y * image.width + panelStart;
      image.data.copy(panel, y * panelWidth, sourceStart, sourceStart + panelWidth);
    }
    panels.push(pack2Bpp(panel));
  }
  return Buffer.concat(panels);
}
