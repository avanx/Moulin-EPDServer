import sharp from "sharp";

import { composeScreenHtml } from "./compose.js";
import { encodeBw, encodeBwry } from "./encode.js";
import { HtmlRenderer } from "./html-renderer.js";
import {
  bwToPng,
  bwryToPng,
  quantizeBw,
  quantizeBwry,
} from "./quantize.js";
import type {
  PanelLayout,
  QuantizedBwImage,
  QuantizedBwryImage,
  ScreenHtmlOptions,
  SharpInput,
} from "./types.js";

export type ColorMode = "bw" | "bwry";

export interface PreparedFrame {
  readonly encoding: "epd-bw-msb-v1" | "edp-bwry-v1";
  readonly sourcePng: Buffer;
  readonly previewPng: Buffer;
  readonly frame: Buffer;
  readonly quantized: QuantizedBwImage | QuantizedBwryImage;
}

export interface RenderScreenOptions extends ScreenHtmlOptions {
  readonly colorMode: ColorMode;
  readonly panelLayout: PanelLayout;
  readonly timeoutMs?: number;
  readonly deviceScaleFactor?: number;
  readonly waitForFonts?: boolean;
}

export async function prepareFrame(
  source: SharpInput,
  colorMode: ColorMode,
  panelLayout: PanelLayout,
): Promise<PreparedFrame> {
  const sourcePng = await sharp(source)
    .removeAlpha()
    .toColourspace("srgb")
    .png()
    .toBuffer();
  if (colorMode === "bw") {
    const quantized = await quantizeBw(sourcePng);
    return {
      encoding: "epd-bw-msb-v1",
      sourcePng,
      previewPng: await bwToPng(quantized),
      frame: encodeBw(quantized),
      quantized,
    };
  }
  if (colorMode === "bwry") {
    const quantized = await quantizeBwry(sourcePng);
    return {
      encoding: "edp-bwry-v1",
      sourcePng,
      previewPng: await bwryToPng(quantized),
      frame: encodeBwry(quantized, panelLayout),
      quantized,
    };
  }
  throw new Error(`Unsupported color mode: ${String(colorMode)}`);
}

export async function renderScreenFrame(
  options: RenderScreenOptions,
  renderer?: HtmlRenderer,
): Promise<PreparedFrame> {
  const activeRenderer = renderer ?? new HtmlRenderer();
  try {
    const html = composeScreenHtml(options);
    const sourcePng = await activeRenderer.renderPng({
      html,
      width: options.width,
      height: options.height,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.deviceScaleFactor === undefined
        ? {}
        : { deviceScaleFactor: options.deviceScaleFactor }),
      ...(options.waitForFonts === undefined
        ? {}
        : { waitForFonts: options.waitForFonts }),
    });
    return await prepareFrame(sourcePng, options.colorMode, options.panelLayout);
  } finally {
    if (renderer === undefined) {
      await activeRenderer.close();
    }
  }
}
